import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { CONTINUATION_EXIT_GRACE_MS, DEFAULT_STEP_TIMEOUT_MS } from "../config/tunables.ts";
import { setStepContinuation } from "../lib/agent-tree-state.ts";
import { notify, markStepWaiting, pushAgentLine, pushStepOutputLine, type LoopState } from "../lib/state.ts";
import { stopFileExists } from "../lib/state-files.ts";
import { CONTINUATION_EXIT_GRACE_POLL_MS, CONTINUATION_MAX_WAIT_MS, CONTINUATION_START_SKEW_MS, CONTINUATION_STALE_MS, CONTINUATION_STATUS_POLL_MS, continuationPollMs, continuationTime, isSafeSessionID, readActiveProjectContinuationRecord, readProjectContinuationRecord, type RunContinuationRecord } from "./continuation-records.ts";
import { probeBackgroundLiveness, sessionPendingState, sessionStillPending, type BackgroundLivenessProbe, type SessionPendingState } from "./session-health.ts";
import { sanitizeLogField, toError } from "./util.ts";
import type { RunControlView } from "../engine/run-control.ts";

export type ContinuationWaitResult = "idle" | "resumed" | "stopped" | "skipped" | "restart" | "stale" | "timeout" | "orphaned";

export { probeBackgroundLiveness };

export async function waitForActiveLoopContinuationRecord({
  client,
  repoDir,
  startedAt,
  sessionID,
}: {
  client: OpencodeClient;
  repoDir: string;
  startedAt: number;
  sessionID: string | undefined;
}): Promise<RunContinuationRecord | null> {
  if (sessionID !== undefined && !isSafeSessionID(sessionID)) return null;

  const deadline = Date.now() + CONTINUATION_EXIT_GRACE_MS;
  let nextStatusPoll = 0;
  while (Date.now() <= deadline) {
    let record: RunContinuationRecord | null;
    try {
      record = sessionID === undefined
        ? readActiveProjectContinuationRecord(repoDir, startedAt)
        : readProjectContinuationRecord(repoDir, sessionID);
    } catch {
      record = null;
    }
    if (record !== null && continuationTime(record) >= startedAt - CONTINUATION_START_SKEW_MS) {
      if (record.source.state === "active") return record;
      if (record.source.state === "idle") return null;
    }

    const now = Date.now();
    if (sessionID !== undefined && now >= nextStatusPoll) {
      nextStatusPoll = now + CONTINUATION_STATUS_POLL_MS;
      let pending = false;
      try {
        pending = await sessionStillPending(client, repoDir, sessionID);
      } catch {
        pending = false;
      }
      if (pending) {
        await Bun.sleep(CONTINUATION_EXIT_GRACE_POLL_MS);
        continue;
      }
    }

    await Bun.sleep(CONTINUATION_EXIT_GRACE_POLL_MS);
  }
  return null;
}

export async function waitForSessionLoopContinuationRecord({
  client,
  repoDir,
  sessionID,
}: {
  client: OpencodeClient;
  repoDir: string;
  sessionID: string;
}): Promise<RunContinuationRecord | null> {
  if (!isSafeSessionID(sessionID)) return null;

  const deadline = Date.now() + CONTINUATION_EXIT_GRACE_MS;
  let nextStatusPoll = 0;
  while (Date.now() <= deadline) {
    let record: RunContinuationRecord | null;
    try {
      record = readProjectContinuationRecord(repoDir, sessionID);
    } catch {
      record = null;
    }
    if (record !== null) {
      if (record.source.state === "active") return record;
      if (record.source.state === "idle") return null;
    }

    const now = Date.now();
    if (now >= nextStatusPoll) {
      nextStatusPoll = now + CONTINUATION_STATUS_POLL_MS;
      let pending = false;
      try {
        pending = await sessionStillPending(client, repoDir, sessionID);
      } catch {
        pending = false;
      }
      if (pending) {
        await Bun.sleep(CONTINUATION_EXIT_GRACE_POLL_MS);
        continue;
      }
    }

    await Bun.sleep(CONTINUATION_EXIT_GRACE_POLL_MS);
  }
  return null;
}

export function logContinuationState(state: LoopState, stepIndex: number, record: RunContinuationRecord, prefix: string): void {
  const reason = record.source.reason ? ` reason=${sanitizeLogField(record.source.reason)}` : "";
  const line = `[looper] ${prefix}: session=${sanitizeLogField(record.sessionID)} state=${record.source.state}${reason} updatedAt=${sanitizeLogField(record.source.updatedAt)}`;
  pushAgentLine(state, line);
  pushStepOutputLine(state, stepIndex, line);
  notify();
}

export function setContinuationStatus(state: LoopState, stepIndex: number, record: RunContinuationRecord): void {
  markStepWaiting(state, stepIndex);
  setStepContinuation(state, stepIndex, {
    reason: record.source.reason ?? "background tasks active",
    since: continuationTime(record) || Date.now(),
  });
}

export function clearContinuationStatus(state: LoopState, stepIndex: number): void {
  setStepContinuation(state, stepIndex, null);
}

export async function waitForLoopContinuationIdle({
  state,
  control,
  client,
  stepIndex,
  repoDir,
  sessionID,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
}: {
  state: LoopState;
  control: RunControlView;
  client: OpencodeClient;
  stepIndex: number;
  repoDir: string;
  sessionID: string;
  timeoutMs?: number;
}): Promise<ContinuationWaitResult> {
  const startedAt = Date.now();

  try {
    while (true) {
      if (control.restartRequested) return "restart";
      if (control.skipRequested) return "skipped";
      if (control.quitting || stopFileExists()) return "stopped";

      let record: RunContinuationRecord | null;
      try {
        record = readProjectContinuationRecord(repoDir, sessionID);
      } catch {
        record = null;
      }

      const backgroundActive = record !== null && record.source.state === "active";
      if (backgroundActive) {
        setContinuationStatus(state, stepIndex, record!);
        const updatedAt = Date.parse(record!.source.updatedAt);
        const markerStale = Number.isFinite(updatedAt) && Date.now() - updatedAt > CONTINUATION_STALE_MS;
        if (markerStale) {
          let probe: BackgroundLivenessProbe;
          try {
            probe = await probeBackgroundLiveness({ client, repoDir, parentSessionID: sessionID });
          } catch (error) {
            probe = { parent: "unknown", pendingChildren: [], errorMessage: toError(error).message };
          }
          const orphaned = probe.errorMessage === undefined && probe.parent === "idle" && probe.pendingChildren.length === 0;
          if (orphaned) {
            logContinuationState(state, stepIndex, record!, "background marker orphaned (stale, no live children)");
            return "orphaned";
          }
        }
      } else {
        // Background tasks report idle: resume only once the session is
        // CONFIRMED idle. sessionPendingState treats a status-read error as
        // "unknown" (not idle), so transient flakiness can't resume into a
        // still-busy session and have opencode drop the continuation prompt.
        let pendingState: SessionPendingState;
        try {
          pendingState = await sessionPendingState(client, repoDir, sessionID);
        } catch {
          pendingState = "unknown";
        }
        if (pendingState === "idle") {
          if (record !== null) {
            setContinuationStatus(state, stepIndex, record);
            logContinuationState(state, stepIndex, record, "background tasks idle");
          }
          return "idle";
        }
        if (pendingState === "pending") {
          // Background tasks report done but the parent session is busy
          // again: opencode's own continuation hook won the race and
          // re-prompted it. Surface this so the caller reattaches and streams
          // the resumed turn instead of polling blind (yellow step, no
          // output) until the whole turn finishes.
          if (record !== null) logContinuationState(state, stepIndex, record, "session resumed by opencode after background tasks");
          return "resumed";
        }
        if (record !== null) setContinuationStatus(state, stepIndex, record);
      }

      if (Date.now() - startedAt > Math.min(CONTINUATION_MAX_WAIT_MS, timeoutMs)) return "timeout";

      await Bun.sleep(continuationPollMs());
    }
  } finally {
    clearContinuationStatus(state, stepIndex);
  }
}
