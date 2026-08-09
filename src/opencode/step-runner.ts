import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { DEFAULT_STEP_TIMEOUT_MS } from "../config/tunables.ts";
import { buildLooperSessionMetadata, type LooperSessionMetadataInput } from "../lib/session-metadata.ts";
import { beginStepRun, clearPendingRequests, finalizeStepRow, notify, pushAgentEvent, pushAgentLine, pushStepOutputEvent, pushStepOutputLine, pushStepOutputLines, setStepLooperMessageIDs, setStepPromptText, setStepSessionID, type LoopState, type StepRestartReason } from "../lib/state.ts";
import { stopFileExists } from "../lib/state-files.ts";
import { createSessionEventConsumer } from "../lib/event-consumer.ts";
import type { PermissionPolicy, QuestionPolicy } from "../lib/config.ts";
import { logContinuationState, setContinuationStatus, waitForActiveLoopContinuationRecord } from "./background-tasks.ts";
import { createPromptEventStream, type PromptEventStream } from "./event-stream.ts";
import type { RunContinuationRecord } from "./continuation-records.ts";
import { classifyAssistantForMessage } from "./assistant-classification.ts";
import { createOpencodeID } from "./opencode-id.ts";
import type { RequestBroker } from "./request-broker.ts";
import { createRequestBrokerOwner, type RequestBrokerOwner } from "./request-broker-owner.ts";
import { createPausableTimeout } from "./pausable-timeout.ts";
import { createRunnerEventController, parseModel, type Step, type StepResult, type StepRunResult } from "./step-runner-types.ts";
import { formatRequestError, isAbortError, toError } from "./util.ts";
import { resolvePromptVariant } from "./variant-resolve.ts";

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
  onSessionBound?: (info: { sessionID: string; messageID: string; promptText: string; looperMessageIDs: string[] }) => void;
  timeoutMsOverride?: number;
  sessionMetadata?: LooperSessionMetadataInput;
  permissionPolicy?: PermissionPolicy;
  questionPolicy?: QuestionPolicy;
  useSessionIdle?: boolean;
  requestBrokerOwner?: RequestBrokerOwner;
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
  requestBrokerOwner,
}: RunOpenCodeStepOptions): Promise<StepRunResult> {
  const activeStep = state.steps[stepIndex];
  if (!activeStep) throw new Error(`missing state step at index ${stepIndex}`);
  const startedAt = Date.now();
  const effectiveTimeoutMs = timeoutMsOverride ?? step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  beginStepRun(state, stepIndex);

  const pushLine = (line: string, at?: number) => {
    pushAgentLine(state, line, at);
    pushStepOutputLine(state, stepIndex, line, at);
  };

  const pushLines = (lines: string[], at?: number) => {
    if (lines.length === 0) return;
    for (const line of lines) pushAgentLine(state, line, at);
    pushStepOutputLines(state, stepIndex, lines, at);
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

  const persistSessionID = (sid: string) => {
    cancellation.activeSessionID = sid;
    setStepSessionID(state, stepIndex, sid);
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
  let timeoutController: ReturnType<typeof createPausableTimeout> | undefined;
  const onTimeout = (): void => {
    if (cancellation.action !== null) return;
    state.restartRequested = true;
    state.restartReason = "timeout";
    notify();
    requestCancellation("timeout");
  };

  let eventStream: PromptEventStream | undefined;
  let requestBroker: RequestBroker | undefined;
  let localBrokerOwner: RequestBrokerOwner | undefined;
  let unsubscribeHumanGate: (() => void) | undefined;
  let teardownError: string | undefined;
  let sessionEventError: Error | undefined;
  let finalError: Error | undefined;
  timeoutController = createPausableTimeout({ durationMs: effectiveTimeoutMs, onElapsed: onTimeout });

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
    const brokerOwner = requestBrokerOwner ?? createRequestBrokerOwner({
      state,
      client,
      repoDir,
      step,
      pushLine,
      unattended: false,
      friction: { counts: new Map(), requestIDs: new Set() },
      ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
      ...(questionPolicy !== undefined ? { questionPolicy } : {}),
    });
    if (requestBrokerOwner === undefined) localBrokerOwner = brokerOwner;
    unsubscribeHumanGate = brokerOwner.subscribeHumanGate(timeoutController.setGateOpen);
    const boundBroker = brokerOwner.bind(boundSessionID);
    const ownedSessions = boundBroker.ownedSessions;
    const hiddenUserMessageIDs = new Set<string>(activeStep.looperMessageIDs ?? []);
    setStepPromptText(state, stepIndex, prompt);

    requestBroker = boundBroker.broker;
    const consumer = createSessionEventConsumer(boundSessionID, {
      pushLine,
      pushLines,
      ownedSessionIDs: () => ownedSessions.ids(),
      onEvent: (event, at) => {
        pushAgentEvent(state, event, at);
        pushStepOutputEvent(state, stepIndex, event, at);
      },
      ...requestBroker.callbacks,
      onSessionError: (message) => {
        sessionEventError ??= new Error(`session.error: ${message}`);
      },
      hiddenUserMessageIDs,
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
      reconcileRequests: brokerOwner.reconcile,
    });
    await eventStream.start();

    const model = parseModel(step.model);
    const variant = await resolvePromptVariant({
      client,
      repoDir,
      model,
      variant: step.variant,
      signal: ctrl.signal,
      log: pushLine,
    });
    const agent = step.agent || undefined;
    const messageID = createOpencodeID("msg");
    sentMessageID = messageID;
    hiddenUserMessageIDs.add(messageID);
    const looperMessageIDs = [...hiddenUserMessageIDs];
    setStepLooperMessageIDs(state, stepIndex, looperMessageIDs);
    eventStream.setSentMessageID(messageID);
    onSessionBound?.({ sessionID: sid, messageID, promptText: prompt, looperMessageIDs: [...looperMessageIDs] });
    pushLine(`[looper] sending prompt (agent=${agent ?? "default"}${model ? ` model=${model.providerID}/${model.modelID}` : ""}${variant !== undefined ? ` variant=${variant}` : ""} messageID=${messageID})`);
    const result = await client.session.prompt(
      {
        sessionID: sid,
        directory: repoDir,
        messageID,
        parts: [{ type: "text", text: prompt }],
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(variant !== undefined ? { variant } : {}),
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
    unsubscribeHumanGate?.();
    timeoutController?.dispose();
    subscription.ctrl?.abort();
    ctrl.abort();
    await eventStream?.stop();
    eventStream?.flush();
    if (cancellation.action !== null && cancellation.activeSessionID !== undefined) {
      const brokerOwner = requestBrokerOwner ?? localBrokerOwner;
      const teardown = await brokerOwner?.teardown(cancellation.activeSessionID);
      if (teardown?.safeToProceed === false) teardownError = teardown.reason;
    }
    localBrokerOwner?.dispose();
    if (requestBrokerOwner === undefined) clearPendingRequests(state);
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

  if (teardownError !== undefined) finalError = new Error(teardownError);
  const status: StepResult =
    teardownError !== undefined ? "failed" :
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
