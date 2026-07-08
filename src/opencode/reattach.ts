import type { OpencodeClient, SessionMessagesResponse2, SessionStatus } from "@opencode-ai/sdk/v2";

import { serverRecoveryProbeTimeoutMs, staleBusyResumeThresholdMs } from "../config/tunables.ts";
import type { PermissionPolicy, QuestionPolicy } from "../lib/config.ts";
import { createSessionEventConsumer } from "../lib/event-consumer.ts";
import { beginStepRun, finalizeStepRow, notify, pushAgentEvent, pushAgentLine, pushStepOutputEvent, pushStepOutputLine, pushStepOutputLines, setStepSessionID, syncStepBackgroundAgents, type FinalizeStepStatus, type LoopState } from "../lib/state.ts";
import { stopFileExists } from "../lib/state-files.ts";
import { continuationBackgroundAgent, continuationFallback, logContinuationState, setContinuationStatus, startBackgroundAgentPoller, waitForSessionLoopContinuationRecord } from "./background-tasks.ts";
import { CONTINUATION_STALE_MS, EVENT_CONSUMER_CLOSE_TIMEOUT_MS, REATTACH_MAX_WAIT_MS, REATTACH_STATUS_POLL_MS, readProjectContinuationRecord, type RunContinuationRecord } from "./continuation-records.ts";
import { createRunnerEventController, type Step, type StepRunResult } from "./step-runner-types.ts";
import { DEADLINE_EXCEEDED, boundedBackgroundLivenessProbe, boundedSessionPendingState, isPendingSessionStatus, withAbortSignal, withDeadline, type SessionPendingState } from "./session-health.ts";
import { classifyAssistantForMessage, type AssistantClassification } from "./assistant-classification.ts";
import { formatRequestError, isAbortError, toError } from "./util.ts";

export type ResumeSessionWorkState = "running" | "idle" | "unknown" | "stale";

type ForegroundActivityState = "recent" | "stale" | "unknown";

function continuationMarkerStale(record: RunContinuationRecord): boolean {
  const updatedAt = Date.parse(record.source.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > CONTINUATION_STALE_MS;
}

function latestMessageActivityAt(messages: SessionMessagesResponse2): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    const createdAt = message.info.time.created;
    if (Number.isFinite(createdAt) && (latest === undefined || createdAt > latest)) latest = createdAt;
    const completedAt = "completed" in message.info.time ? message.info.time.completed : undefined;
    if (completedAt !== undefined && Number.isFinite(completedAt) && (latest === undefined || completedAt > latest)) latest = completedAt;
  }
  return latest;
}

async function foregroundActivityState({
  client,
  repoDir,
  sessionID,
  timeoutMs,
  thresholdMs,
  signal,
}: {
  client: OpencodeClient;
  repoDir: string;
  sessionID: string;
  timeoutMs: number | undefined;
  thresholdMs: number;
  signal?: AbortSignal;
}): Promise<ForegroundActivityState> {
  try {
    const messages = client.session.messages({ sessionID, directory: repoDir });
    const bounded = timeoutMs === undefined ? messages : withDeadline(messages, timeoutMs);
    const result = await withAbortSignal(bounded, signal);
    if (result === DEADLINE_EXCEEDED || result.error || result.data === undefined) return "unknown";
    const latest = latestMessageActivityAt(result.data);
    if (latest === undefined) return "stale";
    return Date.now() - latest <= thresholdMs ? "recent" : "stale";
  } catch {
    return "unknown";
  }
}

export async function resumeSessionWorkState({
  client,
  repoDir,
  sessionID,
  statusTimeoutMs,
  staleBusyThresholdMs,
  signal,
}: {
  client: OpencodeClient;
  repoDir: string;
  sessionID: string;
  statusTimeoutMs?: number;
  staleBusyThresholdMs?: number;
  signal?: AbortSignal;
}): Promise<ResumeSessionWorkState> {
  const timeoutMs = statusTimeoutMs ?? serverRecoveryProbeTimeoutMs();
  let parentState: SessionPendingState;
  try {
    parentState = await boundedSessionPendingState(client, repoDir, sessionID, timeoutMs, signal);
  } catch {
    parentState = "unknown";
  }
  if (parentState === "pending") {
    const activity = await foregroundActivityState({ client, repoDir, sessionID, timeoutMs, thresholdMs: staleBusyThresholdMs ?? staleBusyResumeThresholdMs(), signal });
    if (activity === "recent") return "running";
    if (activity === "unknown") return "unknown";

    try {
      const probe = await boundedBackgroundLivenessProbe({ client, repoDir, parentSessionID: sessionID, timeoutMs, signal });
      if (probe.errorMessage !== undefined) return "unknown";
      if (probe.pendingChildren.length > 0) return "running";
      const record = readProjectContinuationRecord(repoDir, sessionID);
      if (record !== null && record.source.state === "active" && !continuationMarkerStale(record)) return "running";
      return "stale";
    } catch {
      return "unknown";
    }
  }

  let record: RunContinuationRecord | null;
  try {
    record = readProjectContinuationRecord(repoDir, sessionID);
  } catch {
    record = null;
  }
  if (record !== null && record.source.state === "active") {
    if (!continuationMarkerStale(record)) return "running";

    try {
      const probe = await boundedBackgroundLivenessProbe({ client, repoDir, parentSessionID: sessionID, timeoutMs, signal });
      if (probe.errorMessage !== undefined) return "unknown";
      if (probe.parent === "pending" || probe.pendingChildren.length > 0) return "running";
      return probe.parent === "idle" ? "idle" : "unknown";
    } catch {
      return "unknown";
    }
  }

  return parentState;
}

export { assistantErrorMessage, assistantHasMeaningfulActivity, classifyAssistantForMessage, emptyAssistantMessage, isNonRetryableAssistantError } from "./assistant-classification.ts";
export type { AssistantClassification } from "./assistant-classification.ts";

export type PriorSessionEvaluation = {
  statusKnown: boolean;
  pending: boolean;
  classification: AssistantClassification;
};

export async function evaluatePriorSession({
  client,
  repoDir,
  sessionID,
  messageID,
}: {
  client: OpencodeClient;
  repoDir: string;
  sessionID: string;
  messageID: string;
}): Promise<PriorSessionEvaluation> {
  let statusKnown = true;
  let status: SessionStatus | undefined;
  try {
    const r = await client.session.status({ directory: repoDir });
    if (r.error) statusKnown = false;
    else status = r.data?.[sessionID];
  } catch {
    statusKnown = false;
  }
  const pending = statusKnown && isPendingSessionStatus(status);
  const classification = await classifyAssistantForMessage(client, repoDir, sessionID, messageID);
  return { statusKnown, pending, classification };
}

export type ReattachStepOptions = {
  state: LoopState;
  stepIndex: number;
  client: OpencodeClient;
  repoDir: string;
  step: Step;
  sessionID: string;
  messageID: string;
  permissionPolicy?: PermissionPolicy;
  questionPolicy?: QuestionPolicy;
  useSessionIdle?: boolean;
};

export async function reattachOpenCodeStep({
  state,
  stepIndex,
  client,
  repoDir,
  step,
  sessionID,
  messageID,
  permissionPolicy,
  questionPolicy,
  useSessionIdle,
}: ReattachStepOptions): Promise<StepRunResult> {
  const activeStep = state.steps[stepIndex];
  if (!activeStep) throw new Error(`missing state step at index ${stepIndex}`);
  const startedAt = Date.now();

  beginStepRun(state, stepIndex, { statusMessage: "reattaching" });
  setStepSessionID(state, stepIndex, sessionID);

  const pushLine = (line: string) => {
    pushAgentLine(state, line);
    pushStepOutputLine(state, stepIndex, line);
  };
  const pushLines = (lines: string[]) => {
    if (lines.length === 0) return;
    for (const line of lines) pushAgentLine(state, line);
    pushStepOutputLines(state, stepIndex, lines);
  };

  pushLine(`[looper] reattaching to session ${sessionID} (messageID=${messageID}) for ${step.name}`);

  const ctrl = new AbortController();
  let cancellationAction: "skip" | "restart" | null = null;
  let abortSent = false;
  const requestCancellation = (reason: "skip" | "restart") => {
    if (cancellationAction !== null) return;
    cancellationAction = reason;
    pushLine(`[looper] ${reason} requested for ${step.name} during reattach`);
    if (!abortSent) {
      abortSent = true;
      void client.session.abort({ sessionID, directory: repoDir })
        .then((aborted) => {
          if (aborted?.error) pushLine(`[looper] session.abort failed for ${sessionID}: ${formatRequestError(aborted.error)}`);
        })
        .catch((error) => {
          pushLine(`[looper] session.abort threw for ${sessionID}: ${toError(error).message}`);
        });
    }
    ctrl.abort();
  };

  const watcher = setInterval(() => {
    if (cancellationAction !== null) return;
    if (state.restartRequested) requestCancellation("restart");
    else if (state.skipRequested || state.quitting || stopFileExists()) requestCancellation("skip");
  }, 100);
  const bgPoller = startBackgroundAgentPoller({
    state,
    stepIndex,
    client,
    repoDir,
    parentSessionID: sessionID,
    fallbackAgents: continuationFallback(repoDir, sessionID),
  });

  let consumerPromise: Promise<void> | undefined;
  let sessionEventError: Error | undefined;
  let timedOut = false;
  let consecutiveStatusErrors = 0;
  let idleHintConfirmed = false;
  let idleHintProbeInFlight = false;
  let wakeStatusPoll: (() => void) | undefined;
  const wakeReattachStatusPoll = (): void => {
    wakeStatusPoll?.();
    wakeStatusPoll = undefined;
  };
  const probeIdleHint = (): void => {
    if (idleHintConfirmed || idleHintProbeInFlight) return;
    idleHintProbeInFlight = true;
    void client.session.status({ directory: repoDir })
      .then((statusResult) => {
        if (!statusResult.error && !isPendingSessionStatus(statusResult.data?.[sessionID])) idleHintConfirmed = true;
      })
      .catch(() => undefined)
      .finally(() => {
        idleHintProbeInFlight = false;
        wakeReattachStatusPoll();
      });
  };
  const consumer = createSessionEventConsumer(sessionID, {
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
      activeSessionID: sessionID,
      pushLine,
      ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
      ...(questionPolicy !== undefined ? { questionPolicy } : {}),
    }),
    onSessionError: (message) => {
      sessionEventError ??= new Error(`session.error: ${message}`);
    },
    ...(useSessionIdle
      ? {
          onSessionIdle: (payload) => {
            if (payload.sessionID !== sessionID) return;
            probeIdleHint();
          },
        }
      : {}),
  });

  try {
    const sub = await client.event.subscribe({ directory: repoDir }, { signal: ctrl.signal });
    if (!sub.stream) throw new Error("event.subscribe returned no stream");
    pushLine(`[looper] subscribed to events for reattach`);
    consumerPromise = consumer.consume(sub.stream).catch((err) => {
      const error = toError(err);
      if (isAbortError(error)) return;
      pushLine(`[error] event consumer crashed during reattach: ${error.message}`);
    });
  } catch (error) {
    pushLine(`[error] reattach failed to subscribe: ${toError(error).message}`);
  }

  try {
    while (cancellationAction === null) {
      if (idleHintConfirmed) break;
      if (Date.now() - startedAt > REATTACH_MAX_WAIT_MS) {
        timedOut = true;
        break;
      }
      let statusOk = false;
      let stillPending = false;
      let statusErrorMessage: string | undefined;
      try {
        const statusResult = await client.session.status({ directory: repoDir });
        if (!statusResult.error) {
          statusOk = true;
          stillPending = isPendingSessionStatus(statusResult.data?.[sessionID]);
        } else {
          statusErrorMessage = formatRequestError(statusResult.error);
        }
      } catch (error) {
        statusErrorMessage = formatRequestError(error);
      }
      if (statusOk) {
        consecutiveStatusErrors = 0;
        if (!stillPending) break;
      } else {
        consecutiveStatusErrors += 1;
        if (consecutiveStatusErrors >= 5) {
          pushLine(`[looper] reattach: session.status failed ${consecutiveStatusErrors} times in a row; giving up${statusErrorMessage ? `: ${statusErrorMessage}` : ""}`);
          break;
        }
      }
      if (idleHintConfirmed) break;
      let woke = false;
      await Promise.race([
        Bun.sleep(REATTACH_STATUS_POLL_MS),
        new Promise<void>((resolve) => {
          wakeStatusPoll = () => {
            woke = true;
            resolve();
          };
        }),
      ]);
      if (!woke) wakeStatusPoll = undefined;
    }
  } finally {
    clearInterval(watcher);
    bgPoller.stop();
    ctrl.abort();
    if (consumerPromise) {
      let consumerTimedOut = false;
      await Promise.race([
        consumerPromise,
        Bun.sleep(EVENT_CONSUMER_CLOSE_TIMEOUT_MS).then(() => {
          consumerTimedOut = true;
        }),
      ]).catch(() => undefined);
      if (consumerTimedOut) pushLine(`[looper] event stream did not close within ${EVENT_CONSUMER_CLOSE_TIMEOUT_MS}ms after reattach; continuing`);
    }
    try {
      const timeoutMs = serverRecoveryProbeTimeoutMs();
      const msgs = await withDeadline(client.session.messages({ sessionID, directory: repoDir }), timeoutMs);
      if (msgs === DEADLINE_EXCEEDED) pushLine(`[looper] reattach backfill timed out after ${timeoutMs}ms`);
      else if (!msgs.error && msgs.data) consumer.backfill(msgs.data);
    } catch (error) {
      pushLine(`[looper] reattach backfill failed: ${toError(error).message}`);
    }
    consumer.flush();
  }

  const finalize = (
    statusValue: FinalizeStepStatus,
    extras?: { errorMessage?: string; statusMessage?: string },
  ): StepRunResult => {
    finalizeStepRow(state, stepIndex, statusValue, extras?.statusMessage !== undefined ? { statusMessage: extras.statusMessage } : {});
    return {
      status: statusValue,
      sessionID,
      messageID,
      ...(extras?.errorMessage !== undefined ? { errorMessage: extras.errorMessage } : {}),
    };
  };

  if (sessionEventError !== undefined && cancellationAction === null) {
    pushLine(`[error] reattach: ${sessionEventError.message}`);
    return finalize("failed", { errorMessage: sessionEventError.message });
  }

  if (cancellationAction === "restart") return finalize("restart");
  if (cancellationAction === "skip") return finalize("skipped");
  if (timedOut) {
    const reason = `reattach timed out after ${Math.round(REATTACH_MAX_WAIT_MS / 1000)}s waiting for session ${sessionID}`;
    pushLine(`[looper] ${reason}`);
    return finalize("failed", { errorMessage: reason });
  }

  const classification = await classifyAssistantForMessage(client, repoDir, sessionID, messageID);
  if (classification.kind === "done") {
    pushLine(`[looper] reattach: assistant message ${messageID} completed cleanly`);
    let record: RunContinuationRecord | null = null;
    try {
      record = await waitForSessionLoopContinuationRecord({ client, repoDir, sessionID });
    } catch (error) {
      pushLine(`[looper] continuation lookup after reattach threw: ${toError(error).message}`);
    }
    if (record !== null) {
      setContinuationStatus(state, stepIndex, record);
      logContinuationState(state, stepIndex, record, "background tasks active after reattach");
      syncStepBackgroundAgents(state, stepIndex, [continuationBackgroundAgent(record)]);
      activeStep.status = "waiting";
      activeStep.finishedAt = undefined;
      state.activeStepIndex = null;
      notify();
      return { status: "waiting", sessionID: record.sessionID, messageID };
    }
    return finalize("done");
  }
  if (classification.kind === "failed" || classification.kind === "empty") {
    pushLine(`[error] reattach: ${classification.errorMessage}`);
    return finalize("failed", { errorMessage: classification.errorMessage });
  }
  const reason =
    classification.kind === "missing"
      ? `reattach: no assistant message found for prompt ${messageID}`
      : `reattach: assistant message ${messageID} still in-progress after status idle`;
  pushLine(`[looper] ${reason}`);
  return finalize("failed", { errorMessage: reason });
}
