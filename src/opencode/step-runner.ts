import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { DEFAULT_STEP_TIMEOUT_MS } from "../config/tunables.ts";
import { buildLooperSessionMetadata, type LooperSessionMetadataInput } from "../lib/session-metadata.ts";
import { beginStepRun, finalizeStepRow, notify, pushAgentEvent, pushAgentLine, pushStepOutputEvent, pushStepOutputLine, pushStepOutputLines, setStepSessionID, syncStepBackgroundAgents, type LoopState, type StepRestartReason } from "../lib/state.ts";
import { stopFileExists } from "../lib/state-files.ts";
import { createSessionEventConsumer } from "../lib/event-consumer.ts";
import type { PermissionPolicy, QuestionPolicy } from "../lib/config.ts";
import { continuationBackgroundAgent, continuationFallback, logContinuationState, setContinuationStatus, startBackgroundAgentPoller, waitForActiveLoopContinuationRecord, type BackgroundAgentPoller } from "./background-tasks.ts";
import { createPromptEventStream, type PromptEventStream } from "./event-stream.ts";
import type { RunContinuationRecord } from "./continuation-records.ts";
import { classifyAssistantForMessage } from "./assistant-classification.ts";
import { createOpencodeID } from "./opencode-id.ts";
import { createRunnerEventController, parseModel, type Step, type StepResult, type StepRunResult } from "./step-runner-types.ts";
import { formatRequestError, isAbortError, toError } from "./util.ts";

export type { Step, StepResult, StepRunResult } from "./step-runner-types.ts";
export { createRunnerEventController, parseModel } from "./step-runner-types.ts";
export { DEFAULT_STEP_TIMEOUT_MS } from "../config/tunables.ts";

export type RunOpenCodeStepOptions = {
  state: LoopState;
  stepIndex: number;
  prompt: string;
  client: OpencodeClient;
  repoDir: string;
  step: Step;
  sessionID?: string;
  onFirstAssistantContent?: () => void;
  onSessionBound?: (info: { sessionID: string; messageID: string }) => void;
  timeoutMsOverride?: number;
  sessionMetadata?: LooperSessionMetadataInput;
  permissionPolicy?: PermissionPolicy;
  questionPolicy?: QuestionPolicy;
  useSessionIdle?: boolean;
};

export async function runOpenCodeStep({
  state,
  stepIndex,
  prompt,
  client,
  repoDir,
  step,
  sessionID,
  onFirstAssistantContent,
  onSessionBound,
  timeoutMsOverride,
  sessionMetadata,
  permissionPolicy,
  questionPolicy,
}: RunOpenCodeStepOptions): Promise<StepRunResult> {
  const activeStep = state.steps[stepIndex];
  if (!activeStep) throw new Error(`missing state step at index ${stepIndex}`);
  const startedAt = Date.now();
  const effectiveTimeoutMs = timeoutMsOverride ?? step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  beginStepRun(state, stepIndex);

  const pushLine = (line: string) => {
    pushAgentLine(state, line);
    pushStepOutputLine(state, stepIndex, line);
  };

  const pushLines = (lines: string[]) => {
    if (lines.length === 0) return;
    for (const line of lines) pushAgentLine(state, line);
    pushStepOutputLines(state, stepIndex, lines);
  };

  pushLine(`[looper] starting step ${step.name}`);

  let sentMessageID: string | undefined;
  const ctrl = new AbortController();
  const subscription: { ctrl: AbortController | undefined } = { ctrl: undefined };
  const cancellation: { action: "skip" | "restart" | null; reason: StepRestartReason | undefined; abortSent: boolean; activeSessionID: string | undefined } = {
    action: null,
    reason: undefined,
    abortSent: false,
    activeSessionID: sessionID,
  };

  let bgPoller: BackgroundAgentPoller | undefined;
  const persistSessionID = (sid: string) => {
    cancellation.activeSessionID = sid;
    setStepSessionID(state, stepIndex, sid);
    if (bgPoller === undefined) {
      bgPoller = startBackgroundAgentPoller({
        state,
        stepIndex,
        client,
        repoDir,
        parentSessionID: sid,
        fallbackAgents: continuationFallback(repoDir, sid),
      });
    }
  };

  if (sessionID !== undefined) persistSessionID(sessionID);

  const requestCancellation = (reason: "skip" | StepRestartReason) => {
    if (cancellation.action !== null) return;
    cancellation.action = reason === "skip" ? "skip" : "restart";
    cancellation.reason = reason === "skip" ? undefined : reason;
    const label = reason === "timeout" ? `timeout after ${Math.round(effectiveTimeoutMs / 1000)}s` : reason;
    pushLine(`[looper] ${label} requested for ${step.name}`);
    if (cancellation.activeSessionID !== undefined && !cancellation.abortSent) {
      cancellation.abortSent = true;
      const sid = cancellation.activeSessionID;
      void client.session.abort({ sessionID: sid, directory: repoDir })
        .then((aborted) => {
          if (aborted?.error) pushLine(`[looper] session.abort failed for ${sid}: ${formatRequestError(aborted.error)}`);
        })
        .catch((error) => {
          pushLine(`[looper] session.abort threw for ${sid}: ${toError(error).message}`);
        });
    }
    subscription.ctrl?.abort();
    ctrl.abort();
  };

  const watcher = setInterval(() => {
    if (cancellation.action !== null) return;
    if (state.restartRequested) requestCancellation(state.restartReason ?? "manual");
    else if (state.skipRequested || state.quitting || stopFileExists()) requestCancellation("skip");
  }, 100);
  const timeout = setTimeout(() => {
    if (cancellation.action !== null) return;
    state.restartRequested = true;
    state.restartReason = "timeout";
    notify();
    requestCancellation("timeout");
  }, effectiveTimeoutMs);

  let eventStream: PromptEventStream | undefined;
  let sessionEventError: Error | undefined;
  let finalError: Error | undefined;

  try {
    let sid = cancellation.activeSessionID;
    if (sid === undefined) {
      pushLine(`[looper] creating session for ${step.name}`);
      const created = await client.session.create(
        {
          directory: repoDir,
          ...(step.agent ? { agent: step.agent } : {}),
          ...(sessionMetadata !== undefined ? { metadata: buildLooperSessionMetadata(sessionMetadata) } : {}),
        },
        { signal: ctrl.signal },
      );
      if (created.error) throw new Error(`session.create: ${formatRequestError(created.error)}`);
      const createdID = created.data?.id;
      if (!createdID) throw new Error("session.create returned no id");
      sid = createdID;
      persistSessionID(sid);
    }
    pushLine(`[looper] session=${sid}`);
    const boundSessionID = sid;

	  const consumer = createSessionEventConsumer(boundSessionID, {
	    pushLine,
	    pushLines,
	    onEvent: (event) => {
	      pushAgentEvent(state, event);
	      pushStepOutputEvent(state, stepIndex, event);
	    },
	    ...createRunnerEventController({
        state,
        client,
        repoDir,
        step,
        activeSessionID: boundSessionID,
        pushLine,
        ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
        ...(questionPolicy !== undefined ? { questionPolicy } : {}),
      }),
      onSessionError: (message) => {
        sessionEventError ??= new Error(`session.error: ${message}`);
      },
      ...(onFirstAssistantContent ? { onFirstAssistantContent } : {}),
    });

    eventStream = createPromptEventStream({
      client,
      repoDir,
      sessionID: boundSessionID,
      subscription,
      promptAbortController: ctrl,
      cancellationActive: () => cancellation.action !== null,
      pushLine,
      consumer,
    });
    await eventStream.start();

    const model = parseModel(step.model);
    const variant = step.variant || undefined;
    const agent = step.agent || undefined;
    const messageID = createOpencodeID("msg");
    sentMessageID = messageID;
    eventStream.setSentMessageID(messageID);
    onSessionBound?.({ sessionID: sid, messageID });
    pushLine(`[looper] sending prompt (agent=${agent ?? "default"}${model ? ` model=${model.providerID}/${model.modelID}` : ""}${variant ? ` variant=${variant}` : ""} messageID=${messageID})`);
    const result = await client.session.prompt(
      {
        sessionID: sid,
        directory: repoDir,
        messageID,
        parts: [{ type: "text", text: prompt }],
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(variant ? { variant } : {}),
      },
      { signal: ctrl.signal },
    );
    if (result.error) throw new Error(`session.prompt: ${formatRequestError(result.error)}`);
    pushLine(`[looper] prompt completed`);
  } catch (error) {
    if (cancellation.action === null) {
      const watchdogStallReason = eventStream?.watchdogStallReason();
      if (watchdogStallReason !== undefined && error instanceof Error && isAbortError(error)) {
        finalError = new Error(watchdogStallReason);
      } else {
        finalError = error instanceof Error ? error : new Error(String(error));
      }
    }
  } finally {
    clearInterval(watcher);
    clearTimeout(timeout);
    bgPoller?.stop();
    subscription.ctrl?.abort();
    ctrl.abort();
    await eventStream?.stop();
    eventStream?.flush();
  }

  const consumerError = eventStream?.consumerError();
  if (finalError === undefined && cancellation.action === null && consumerError !== undefined) {
    finalError = consumerError;
  }
  if (finalError === undefined && cancellation.action === null && sessionEventError !== undefined) {
    finalError = sessionEventError;
  }
  if (finalError === undefined && cancellation.action === null && cancellation.activeSessionID !== undefined && sentMessageID !== undefined) {
    const classification = await classifyAssistantForMessage(client, repoDir, cancellation.activeSessionID, sentMessageID);
    if (classification.kind === "failed" || classification.kind === "empty") finalError = new Error(classification.errorMessage);
  }

  const status: StepResult =
    cancellation.action === "restart" ? "restart" :
    cancellation.action === "skip" ? "skipped" :
    finalError ? "failed" : "done";

  if (finalError) pushLine(`[error] ${finalError.message}`);

  if (status === "done" && cancellation.activeSessionID !== undefined) {
    let record: RunContinuationRecord | null = null;
    try {
      record = await waitForActiveLoopContinuationRecord({
        client,
        repoDir,
        startedAt,
        sessionID: cancellation.activeSessionID,
      });
    } catch (error) {
      pushLine(`[looper] continuation lookup after opencode exit threw: ${toError(error).message}`);
    }
    if (record !== null) {
      setContinuationStatus(state, stepIndex, record);
      logContinuationState(state, stepIndex, record, "background tasks active after opencode exit");
      syncStepBackgroundAgents(state, stepIndex, [continuationBackgroundAgent(record)]);
      return { status: "waiting", sessionID: record.sessionID, ...(sentMessageID !== undefined ? { messageID: sentMessageID } : {}) };
    }
  }

  finalizeStepRow(state, stepIndex, status);

  return {
    status,
    sessionID: cancellation.activeSessionID,
    ...(status === "failed" && finalError ? { errorMessage: finalError.message } : {}),
    ...(sentMessageID !== undefined ? { messageID: sentMessageID } : {}),
    ...(status === "restart" && cancellation.reason !== undefined ? { restartReason: cancellation.reason } : {}),
  };
}
