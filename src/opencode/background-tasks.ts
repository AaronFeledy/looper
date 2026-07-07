import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { CONTINUATION_EXIT_GRACE_MS, DEFAULT_STEP_TIMEOUT_MS } from "../config/tunables.ts";
import { notify, markStepWaiting, pushAgentLine, pushStepOutputLine, syncStepBackgroundAgents, type LoopState } from "../lib/state.ts";
import { stopFileExists } from "../lib/state-files.ts";
import { CONTINUATION_EXIT_GRACE_POLL_MS, CONTINUATION_MAX_WAIT_MS, CONTINUATION_POLL_MS, CONTINUATION_START_SKEW_MS, CONTINUATION_STALE_MS, CONTINUATION_STATUS_POLL_MS, continuationTime, isSafeSessionID, readActiveProjectContinuationRecord, readProjectContinuationRecord, type RunContinuationRecord } from "./continuation-records.ts";
import { isPendingSessionStatus, probeBackgroundLiveness, sessionPendingState, sessionStillPending, type BackgroundLivenessProbe, type LiveBackgroundAgentSnapshot, type SessionPendingState } from "./session-health.ts";
import { sanitizeLogField, formatRequestError, toError } from "./util.ts";

export type ContinuationWaitResult = "idle" | "stopped" | "skipped" | "restart" | "stale" | "timeout" | "orphaned";
export type BackgroundAgentSnapshot = { sessionID: string; agent?: string; title?: string; placeholder?: true; startedAt: number };
type LiveBackgroundAgentScan = { agents: LiveBackgroundAgentSnapshot[]; errorMessage?: string };

const BACKGROUND_AGENT_POLL_MS = 2_500;

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

export function setContinuationStatus(state: LoopState, stepIndex: number, _record: RunContinuationRecord): void {
  markStepWaiting(state, stepIndex);
}

export function continuationBackgroundAgent(record: RunContinuationRecord): BackgroundAgentSnapshot {
  const startedAt = continuationTime(record);
  return {
    sessionID: `continuation-${record.sessionID}`,
    title: record.source.reason ?? "background tasks active",
    placeholder: true,
    startedAt: startedAt > 0 ? startedAt : Date.now(),
  };
}

export function continuationFallback(repoDir: string, sessionID: string): () => BackgroundAgentSnapshot[] {
  return () => {
    const record = readProjectContinuationRecord(repoDir, sessionID);
    return record !== null && record.source.state === "active" ? [continuationBackgroundAgent(record)] : [];
  };
}

export async function snapshotLiveBackgroundAgents({
  client,
  repoDir,
  parentSessionID,
}: {
  client: OpencodeClient;
  repoDir: string;
  parentSessionID: string;
}): Promise<LiveBackgroundAgentScan> {
  const [childrenResult, statusResult] = await Promise.all([
    client.session.children({ sessionID: parentSessionID, directory: repoDir }),
    client.session.status({ directory: repoDir }),
  ]);
  if (childrenResult.error) return { agents: [], errorMessage: `session.children failed: ${formatRequestError(childrenResult.error)}` };
  if (!childrenResult.data) return { agents: [], errorMessage: "session.children returned no data" };
  if (statusResult.error) return { agents: [], errorMessage: `session.status failed: ${formatRequestError(statusResult.error)}` };
  if (!statusResult.data) return { agents: [], errorMessage: "session.status returned no data" };

  const statusMap = statusResult.data;
  const liveAgents: LiveBackgroundAgentSnapshot[] = [];
  for (const child of childrenResult.data) {
    if (!isPendingSessionStatus(statusMap[child.id])) continue;
    liveAgents.push({
      sessionID: child.id,
      ...(child.agent !== undefined ? { agent: child.agent } : {}),
      ...(child.title !== undefined && child.title.length > 0 ? { title: child.title } : {}),
      startedAt: child.time?.created ?? Date.now(),
    });
  }
  return { agents: liveAgents };
}

export type BackgroundAgentPoller = { stop: () => void };

export function startBackgroundAgentPoller({
  state,
  stepIndex,
  client,
  repoDir,
  parentSessionID,
  fallbackAgents,
}: {
  state: LoopState;
  stepIndex: number;
  client: OpencodeClient;
  repoDir: string;
  parentSessionID: string;
  fallbackAgents?: () => BackgroundAgentSnapshot[];
}): BackgroundAgentPoller {
  let stopped = false;
  let inflight = false;
  let errorLogged = false;

  const logPollerError = (message: string): void => {
    if (stopped || errorLogged) return;
    errorLogged = true;
    const line = `[looper] background agent poller ${message}`;
    pushAgentLine(state, line);
    pushStepOutputLine(state, stepIndex, line);
    notify();
  };

  const tick = async (): Promise<void> => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      const liveAgents = await snapshotLiveBackgroundAgents({ client, repoDir, parentSessionID });
      if (liveAgents.errorMessage !== undefined) logPollerError(liveAgents.errorMessage);
      const agents = liveAgents.agents.length > 0 ? liveAgents.agents : fallbackAgents?.() ?? [];
      if (stopped) return;
      syncStepBackgroundAgents(state, stepIndex, agents);
    } catch (error) {
      logPollerError(`threw: ${toError(error).message}`);
    } finally {
      inflight = false;
    }
  };

  void tick();
  const handle = setInterval(() => {
    void tick();
  }, BACKGROUND_AGENT_POLL_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

export async function waitForLoopContinuationIdle({
  state,
  client,
  stepIndex,
  repoDir,
  sessionID,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
}: {
  state: LoopState;
  client: OpencodeClient;
  stepIndex: number;
  repoDir: string;
  sessionID: string;
  timeoutMs?: number;
}): Promise<ContinuationWaitResult> {
  const startedAt = Date.now();
  const poller = startBackgroundAgentPoller({
    state,
    stepIndex,
    client,
    repoDir,
    parentSessionID: sessionID,
    fallbackAgents: continuationFallback(repoDir, sessionID),
  });

  try {
    while (true) {
      if (state.restartRequested) return "restart";
      if (state.skipRequested) return "skipped";
      if (state.quitting || stopFileExists()) return "stopped";

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
        if (record !== null) setContinuationStatus(state, stepIndex, record);
      }

      if (Date.now() - startedAt > Math.min(CONTINUATION_MAX_WAIT_MS, timeoutMs)) return "timeout";

      await Bun.sleep(CONTINUATION_POLL_MS);
    }
  } finally {
    poller.stop();
    syncStepBackgroundAgents(state, stepIndex, []);
  }
}
