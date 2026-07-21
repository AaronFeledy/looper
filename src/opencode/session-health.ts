import type { OpencodeClient, SessionStatus } from "@opencode-ai/sdk/v2";

import { STOP_SESSION_CONFIRM_POLL_MS, serverRecoveryBackoffBaseMs, serverRecoveryBackoffMaxMs, serverRecoveryMaxWaitMs, serverRecoveryProbeTimeoutMs, stopSessionConfirmTimeoutMs } from "../config/tunables.ts";
import { backoffDelayMs } from "../core/backoff.ts";
import type { SessionHealthState, SessionPendingState } from "../core/session-types.ts";
import { formatRequestError, toError } from "./util.ts";

export type { SessionHealthState, SessionPendingState } from "../core/session-types.ts";

function serverRecoveryDelayMs(attempt: number, remainingMs: number): number {
  return backoffDelayMs(
    { baseMs: serverRecoveryBackoffBaseMs(), maxDelayMs: serverRecoveryBackoffMaxMs() },
    Math.max(0, attempt - 1),
    remainingMs,
  );
}

async function sleepUntilServerRecoveryRetry(ms: number, shouldStop?: () => boolean): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, ms);
  while (Date.now() < deadline) {
    if (shouldStop?.()) return false;
    await Bun.sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  return true;
}

export function isPendingSessionStatus(status: SessionStatus | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry";
}

/**
 * Legacy boolean pending check. Treats a `session.status` error as "not
 * pending" so the continuation-record waiters fall through rather than spin.
 * Orchestration session-lifecycle boundaries must use {@link sessionPendingState}
 * instead, which preserves the "unknown" case (a status error must NOT be read
 * as "stopped" — doing so would re-open the resume-into-busy-session bug
 * under transient status flakiness).
 */
export async function sessionStillPending(client: OpencodeClient, repoDir: string, sessionID: string): Promise<boolean> {
  const result = await client.session.status({ directory: repoDir });
  if (result.error) return false;
  return isPendingSessionStatus(result.data?.[sessionID]);
}

/**
 * Tri-state pending check for session-lifecycle decisions. Distinguishes a
 * confirmed-idle session from one whose status we could not read. Callers that
 * are about to resume or create a session must treat `"unknown"` like
 * `"pending"` (do not resume / do not create a fresh session yet).
 */
export async function sessionPendingState(
  client: OpencodeClient,
  repoDir: string,
  sessionID: string,
): Promise<SessionPendingState> {
  try {
    const result = await client.session.status({ directory: repoDir });
    if (result.error) return "unknown";
    return isPendingSessionStatus(result.data?.[sessionID]) ? "pending" : "idle";
  } catch {
    return "unknown";
  }
}

export async function waitForSessionHealth({
  client,
  repoDir,
  sessionID,
  maxWaitMs = serverRecoveryMaxWaitMs(),
  log,
  shouldStop,
}: {
  client: OpencodeClient;
  repoDir: string;
  sessionID: string;
  maxWaitMs?: number;
  log?: (line: string) => void;
  shouldStop?: () => boolean;
}): Promise<SessionHealthState> {
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  let attempt = 0;

  while (true) {
    if (shouldStop?.()) return "stopped";
    const probeBudget = Math.min(serverRecoveryProbeTimeoutMs(), Math.max(1, deadline - Date.now()));
    const probe = await withDeadline(sessionPendingState(client, repoDir, sessionID), probeBudget);
    const state = probe === DEADLINE_EXCEEDED ? "unknown" : probe;
    if (state !== "unknown") {
      if (attempt > 0) log?.(`[looper] server health recovered while checking session ${sessionID}; session is ${state}`);
      return state;
    }

    if (shouldStop?.()) return "stopped";
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      log?.(`[looper] server still unavailable after ${Math.round(maxWaitMs / 1000)}s while checking session ${sessionID}`);
      return "unknown";
    }

    attempt += 1;
    const delay = serverRecoveryDelayMs(attempt, remaining);
    log?.(`[looper] server unavailable while checking session ${sessionID}; retrying health check in ${Math.ceil(delay / 1000)}s`);
    if (!(await sleepUntilServerRecoveryRetry(delay, shouldStop))) return "stopped";
  }
}

export const DEADLINE_EXCEEDED = Symbol("deadline-exceeded");

/** Race a promise against a deadline. Returns the sentinel if it does not settle in time. */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof DEADLINE_EXCEEDED> {
  if (ms <= 0) return DEADLINE_EXCEEDED;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("operation aborted");
}

export async function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) throw abortReason(signal);
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    removeAbortListener?.();
  }
}

export async function boundedSessionPendingState(
  client: OpencodeClient,
  repoDir: string,
  sessionID: string,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<SessionPendingState> {
  const pending = sessionPendingState(client, repoDir, sessionID);
  const bounded = timeoutMs === undefined ? pending : withDeadline(pending, timeoutMs);
  const result = await withAbortSignal(bounded, signal);
  return result === DEADLINE_EXCEEDED ? "unknown" : result;
}

export type LiveBackgroundAgentSnapshot = { sessionID: string; agent?: string; title?: string; startedAt: number };

export type BackgroundLivenessProbe = {
  parent: SessionPendingState;
  pendingChildren: LiveBackgroundAgentSnapshot[];
  errorMessage?: string;
};

export async function probeBackgroundLiveness({
  client,
  repoDir,
  parentSessionID,
}: {
  client: OpencodeClient;
  repoDir: string;
  parentSessionID: string;
}): Promise<BackgroundLivenessProbe> {
  const [childrenResult, statusResult] = await Promise.all([
    client.session.children({ sessionID: parentSessionID, directory: repoDir }),
    client.session.status({ directory: repoDir }),
  ]);
  if (statusResult.error) return { parent: "unknown", pendingChildren: [], errorMessage: `session.status failed: ${formatRequestError(statusResult.error)}` };
  if (!statusResult.data) return { parent: "unknown", pendingChildren: [], errorMessage: "session.status returned no data" };

  const statusMap = statusResult.data;
  const parent: SessionPendingState = isPendingSessionStatus(statusMap[parentSessionID]) ? "pending" : "idle";

  if (childrenResult.error) return { parent, pendingChildren: [], errorMessage: `session.children failed: ${formatRequestError(childrenResult.error)}` };
  if (!childrenResult.data) return { parent, pendingChildren: [], errorMessage: "session.children returned no data" };

  const pendingChildren: LiveBackgroundAgentSnapshot[] = [];
  for (const child of childrenResult.data) {
    if (!isPendingSessionStatus(statusMap[child.id])) continue;
    pendingChildren.push({
      sessionID: child.id,
      ...(child.agent !== undefined ? { agent: child.agent } : {}),
      ...(child.title !== undefined && child.title.length > 0 ? { title: child.title } : {}),
      startedAt: child.time?.created ?? Date.now(),
    });
  }
  return { parent, pendingChildren };
}

export async function boundedBackgroundLivenessProbe({
  client,
  repoDir,
  parentSessionID,
  timeoutMs,
  signal,
}: {
  client: OpencodeClient;
  repoDir: string;
  parentSessionID: string;
  timeoutMs: number | undefined;
  signal?: AbortSignal;
}): Promise<BackgroundLivenessProbe> {
  const effectiveTimeoutMs = timeoutMs ?? serverRecoveryProbeTimeoutMs();
  const result = await withAbortSignal(withDeadline(probeBackgroundLiveness({ client, repoDir, parentSessionID }), effectiveTimeoutMs), signal);
  return result === DEADLINE_EXCEEDED
    ? { parent: "unknown", pendingChildren: [], errorMessage: `background liveness probe timed out after ${effectiveTimeoutMs}ms` }
    : result;
}

/**
 * Tell opencode to abort `sessionID` and wait until the server confirms it is
 * no longer pending (or the timeout elapses). Returns `true` only when the
 * session is CONFIRMED stopped; `false` if it was still pending/unknown at the
 * deadline (or the abort/status calls hung).
 *
 * This is the safe precondition for creating a NEW session for a step, or for
 * resuming one: a client-side request abort (AbortController) never stops
 * opencode's server-side generation — only `session.abort` does, and it is
 * async server-side. Without confirmation, a retry/restart can leave the prior
 * session generating while a fresh one starts (two concurrent runs), and
 * resuming a still-busy session silently drops the resume prompt (opencode's
 * per-session mutex persists the message but ignores its generation).
 *
 * The ENTIRE operation — the abort call and every status poll — is bounded
 * by `timeoutMs` so a hung HTTP call can never deadlock the loop. Polls
 * `session.status` only (never `session.messages`) so it is cheap and never
 * perturbs message history. A `false` return means "could not confirm
 * stopped"; callers should treat that as a retryable condition, not as
 * permission to assume the session is gone.
 */
export async function stopServerSession({
  client,
  repoDir,
  sessionID,
  timeoutMs,
  log,
}: {
  client: OpencodeClient;
  repoDir: string;
  sessionID: string;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<boolean> {
  const effectiveTimeoutMs = timeoutMs ?? stopSessionConfirmTimeoutMs();
  const deadline = Date.now() + Math.max(0, effectiveTimeoutMs);
  const remaining = (): number => deadline - Date.now();

  try {
    const aborted = await withDeadline(client.session.abort({ sessionID, directory: repoDir }), remaining());
    if (aborted === DEADLINE_EXCEEDED) {
      log?.(`[looper] session.abort for ${sessionID} did not return within ${effectiveTimeoutMs}ms; could not confirm stop`);
      return false;
    }
    if (aborted?.error) log?.(`[looper] session.abort failed for ${sessionID}: ${formatRequestError(aborted.error)}`);
  } catch (error) {
    log?.(`[looper] session.abort threw for ${sessionID}: ${toError(error).message}`);
  }

  let unknownStatusAttempts = 0;
  while (true) {
    const probe = await withDeadline(sessionPendingState(client, repoDir, sessionID), remaining());
    const state = probe === DEADLINE_EXCEEDED ? "unknown" : probe;
    if (state === "idle") return true;
    if (state === "unknown") unknownStatusAttempts += 1;
    else unknownStatusAttempts = 0;
    if (remaining() <= 0) {
      log?.(`[looper] session ${sessionID} still ${state} ${effectiveTimeoutMs}ms after abort; could not confirm stop`);
      return false;
    }
    const delay = state === "unknown"
      ? serverRecoveryDelayMs(unknownStatusAttempts, remaining())
      : Math.min(STOP_SESSION_CONFIRM_POLL_MS, Math.max(1, remaining()));
    await Bun.sleep(delay);
  }
}
