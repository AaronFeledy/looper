import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { Event, OpencodeClient, SessionStatus } from "@opencode-ai/sdk/v2";

import { consumeSessionEvents, createSessionEventConsumer } from "./event-consumer.ts";
import {
  beginStepRun,
  finalizeStepRow,
  markStepWaiting,
  notify,
  pushAgentLine,
  pushStepOutputLine,
  pushStepOutputLines,
  setStepSessionID,
  syncStepBackgroundAgents,
  type FinalizeStepStatus,
  type LoopState,
  type StepRestartReason,
} from "./state.ts";
import { stopFileExists } from "./state-files.ts";

export type Step = {
  name: string;
  agent?: string;
  variant?: string;
  model?: string;
  prompt: string;
  prefix?: string;
  suffix?: string;
  args?: string[];
  timeoutMs?: number;
  /** `true` = generate title at step end. `number` = N seconds after first assistant response, concurrently. `"branch"` = fire when the branch watcher detects a switch to a non-trivial branch; fallback to ~5min after first response or step end. See README. */
  title?: boolean | number | "branch";
};

export const DEFAULT_STEP_TIMEOUT_MS = 60 * 60 * 1000;

export type StepResult = "done" | "failed" | "skipped" | "restart" | "waiting";

export type StepRunResult = {
  status: StepResult;
  sessionID?: string;
  errorMessage?: string;
  messageID?: string;
  restartReason?: StepRestartReason;
};

type ContinuationState = "active" | "idle";

type BackgroundTaskSource = {
  state: ContinuationState;
  reason?: string;
  updatedAt: string;
};

type RunContinuationRecord = {
  sessionID: string;
  updatedAt: string;
  source: BackgroundTaskSource;
};

type BackgroundAgentSnapshot = { sessionID: string; agent?: string; title?: string; placeholder?: true; startedAt: number };

type LiveBackgroundAgentSnapshot = { sessionID: string; agent?: string; title?: string; startedAt: number };

type LiveBackgroundAgentScan = { agents: LiveBackgroundAgentSnapshot[]; errorMessage?: string };

export type ContinuationWaitResult = "idle" | "stopped" | "skipped" | "restart" | "stale" | "timeout" | "orphaned";

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CONTINUATION_POLL_MS = 5_000;
const CONTINUATION_MAX_WAIT_MS = 60 * 60 * 1000;
const CONTINUATION_STALE_MS = 15 * 60 * 1000;
const CONTINUATION_START_SKEW_MS = 5_000;
const CONTINUATION_EXIT_GRACE_MS = positiveIntegerEnv("LOOPER_CONTINUATION_EXIT_GRACE_MS", 30_000);
const CONTINUATION_EXIT_GRACE_POLL_MS = 100;
const CONTINUATION_STATUS_POLL_MS = 1_000;
const REATTACH_STATUS_POLL_MS = 2_000;
const REATTACH_MAX_WAIT_MS = 60 * 60 * 1000;
/**
 * Cap for the active-record scan only. Scoped lookups by sessionID bypass this
 * and read `<sessionID>.json` directly so a long-lived run-continuation dir
 * never silently drops the record we actually care about.
 */
const CONTINUATION_MAX_FILES = 1_000;
const CONTINUATION_MAX_BYTES = 64 * 1024;
const CONTINUATION_LOG_FIELD_MAX = 200;
const EVENT_CONSUMER_CLOSE_TIMEOUT_MS = 2_000;
const EVENT_WATCHDOG_POLL_MS = positiveIntegerEnv("LOOPER_EVENT_WATCHDOG_POLL_MS", 15_000);
const EVENT_STALL_THRESHOLD_MS = positiveIntegerEnv("LOOPER_EVENT_STALL_MS", 45_000);
const EVENT_RESUBSCRIBE_BACKOFF_MS = positiveIntegerEnv("LOOPER_EVENT_RESUBSCRIBE_BACKOFF_MS", 1_000);
/**
 * How long `stopServerSession` waits for opencode to confirm (via
 * `session.status`) that an aborted session is no longer pending before it
 * gives up and proceeds anyway. Aborting the client request never stops
 * server-side generation — only `session.abort` does, and that is async on
 * the server — so callers about to create a NEW session for a step must
 * confirm the old one actually stopped to avoid two concurrent generations.
 */
const STOP_SESSION_CONFIRM_TIMEOUT_MS = positiveIntegerEnv("LOOPER_STOP_SESSION_TIMEOUT_MS", 10_000);
const STOP_SESSION_CONFIRM_POLL_MS = positiveIntegerEnv("LOOPER_STOP_SESSION_POLL_MS", 250);

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
};

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash === -1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

const ID_BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdTimestamp = 0;
let idCounter = 0;

export function createOpencodeID(prefix: string): string {
  const currentTimestamp = Date.now();
  if (currentTimestamp !== lastIdTimestamp) {
    lastIdTimestamp = currentTimestamp;
    idCounter = 0;
  }
  idCounter += 1;
  const value = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(idCounter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) {
    timeBytes[i] = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  const random = randomBytes(14);
  let suffix = "";
  for (let i = 0; i < 14; i += 1) suffix += ID_BASE62[random[i]! % 62];
  return `${prefix}_${timeBytes.toString("hex")}${suffix}`;
}

function formatRequestError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  if (error === undefined) return "unknown error";
  return JSON.stringify(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function sanitizeLogField(value: string): string {
  return value
    .replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, CONTINUATION_LOG_FIELD_MAX);
}

function parseBackgroundTaskSource(value: unknown): BackgroundTaskSource | null {
  if (!isRecord(value)) return null;

  const state = value.state;
  if (state !== "active" && state !== "idle") return null;

  const updatedAt = stringValue(value.updatedAt);
  if (updatedAt === undefined) return null;

  const reason = stringValue(value.reason);
  return reason === undefined ? { state, updatedAt } : { state, updatedAt, reason };
}

function parseContinuationRecord(content: string): RunContinuationRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isRecord(value)) return null;

  const sessionID = stringValue(value.sessionID);
  const updatedAt = stringValue(value.updatedAt);
  const sources = isRecord(value.sources) ? value.sources : null;
  const source = sources === null ? null : parseBackgroundTaskSource(sources["background-task"]);
  if (sessionID === undefined || updatedAt === undefined || source === null) return null;

  return { sessionID, updatedAt, source };
}

function continuationTime(record: RunContinuationRecord): number {
  const sourceTime = Date.parse(record.source.updatedAt);
  if (Number.isFinite(sourceTime)) return sourceTime;

  const recordTime = Date.parse(record.updatedAt);
  return Number.isFinite(recordTime) ? recordTime : 0;
}

function readContinuationRecordFromPath(path: string, expectedName?: string): RunContinuationRecord | null {
  let content: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > CONTINUATION_MAX_BYTES) return null;
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  const record = parseContinuationRecord(content);
  if (record === null) return null;
  if (expectedName !== undefined && expectedName !== `${record.sessionID}.json`) return null;
  return record;
}

function continuationDir(repoDir: string): string {
  return join(repoDir, ".omo", "run-continuation");
}

function isSafeSessionID(sessionID: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionID);
}

function readProjectContinuationRecords(repoDir: string): RunContinuationRecord[] {
  const dir = continuationDir(repoDir);
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const jsonEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  // Sort newest-first by mtime so the cap can never silently hide a recent record.
  const annotated = jsonEntries
    .map((entry) => {
      const path = join(dir, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      return { entry, path, mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, CONTINUATION_MAX_FILES);

  const records: RunContinuationRecord[] = [];
  for (const { entry, path } of annotated) {
    const record = readContinuationRecordFromPath(path, entry.name);
    if (record !== null) records.push(record);
  }
  return records;
}

function newestRecord(records: RunContinuationRecord[]): RunContinuationRecord | null {
  return records.sort((left, right) => continuationTime(right) - continuationTime(left))[0] ?? null;
}

function readProjectContinuationRecord(repoDir: string, sessionID: string): RunContinuationRecord | null {
  // Read the specific file directly so we never miss it because of the
  // active-scan cap. Falls back to scan-and-filter in case of corruption.
  if (isSafeSessionID(sessionID)) {
    const dir = resolve(continuationDir(repoDir));
    const path = resolve(dir, `${sessionID}.json`);
    if (path.startsWith(`${dir}${sep}`)) {
      const direct = readContinuationRecordFromPath(path, `${sessionID}.json`);
      if (direct !== null && direct.sessionID === sessionID) return direct;
    }
  }
  return newestRecord(readProjectContinuationRecords(repoDir).filter((record) => record.sessionID === sessionID));
}

function readActiveProjectContinuationRecord(repoDir: string, startedAt: number): RunContinuationRecord | null {
  const minTime = startedAt - CONTINUATION_START_SKEW_MS;
  return newestRecord(
    readProjectContinuationRecords(repoDir).filter(
      (record) => record.source.state === "active" && continuationTime(record) >= minTime,
    ),
  );
}

function isPendingSessionStatus(status: SessionStatus | undefined): boolean {
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

export type SessionPendingState = "pending" | "idle" | "unknown";

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

const DEADLINE_EXCEEDED = Symbol("deadline-exceeded");

/** Race a promise against a deadline. Returns the sentinel if it does not settle in time. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof DEADLINE_EXCEEDED> {
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
  timeoutMs = STOP_SESSION_CONFIRM_TIMEOUT_MS,
  log,
}: {
  client: OpencodeClient;
  repoDir: string;
  sessionID: string;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const remaining = (): number => deadline - Date.now();

  try {
    const aborted = await withDeadline(client.session.abort({ sessionID, directory: repoDir }), remaining());
    if (aborted === DEADLINE_EXCEEDED) {
      log?.(`[looper] session.abort for ${sessionID} did not return within ${timeoutMs}ms; could not confirm stop`);
      return false;
    }
    if (aborted?.error) log?.(`[looper] session.abort failed for ${sessionID}: ${formatRequestError(aborted.error)}`);
  } catch (error) {
    log?.(`[looper] session.abort threw for ${sessionID}: ${toError(error).message}`);
  }

  while (true) {
    const probe = await withDeadline(sessionPendingState(client, repoDir, sessionID), remaining());
    const state = probe === DEADLINE_EXCEEDED ? "unknown" : probe;
    if (state === "idle") return true;
    if (remaining() <= 0) {
      log?.(`[looper] session ${sessionID} still ${state} ${timeoutMs}ms after abort; could not confirm stop`);
      return false;
    }
    await Bun.sleep(Math.min(STOP_SESSION_CONFIRM_POLL_MS, Math.max(1, remaining())));
  }
}

async function waitForActiveLoopContinuationRecord({
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

async function waitForSessionLoopContinuationRecord({
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

function logContinuationState(state: LoopState, stepIndex: number, record: RunContinuationRecord, prefix: string): void {
  const reason = record.source.reason ? ` reason=${sanitizeLogField(record.source.reason)}` : "";
  const line = `[looper] ${prefix}: session=${sanitizeLogField(record.sessionID)} state=${record.source.state}${reason} updatedAt=${sanitizeLogField(record.source.updatedAt)}`;
  pushAgentLine(state, line);
  pushStepOutputLine(state, stepIndex, line);
  notify();
}

function setContinuationStatus(state: LoopState, stepIndex: number, _record: RunContinuationRecord): void {
  markStepWaiting(state, stepIndex);
}

function continuationBackgroundAgent(record: RunContinuationRecord): BackgroundAgentSnapshot {
  const startedAt = continuationTime(record);
  return {
    sessionID: `continuation-${record.sessionID}`,
    title: record.source.reason ?? "background tasks active",
    placeholder: true,
    startedAt: startedAt > 0 ? startedAt : Date.now(),
  };
}

function continuationFallback(repoDir: string, sessionID: string): () => BackgroundAgentSnapshot[] {
  return () => {
    const record = readProjectContinuationRecord(repoDir, sessionID);
    return record !== null && record.source.state === "active" ? [continuationBackgroundAgent(record)] : [];
  };
}

const BACKGROUND_AGENT_POLL_MS = 2_500;

async function snapshotLiveBackgroundAgents({
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

type BackgroundLivenessProbe = {
  parent: SessionPendingState;
  pendingChildren: LiveBackgroundAgentSnapshot[];
  errorMessage?: string;
};

/**
 * Authoritative liveness probe for a step's background work, used to decide
 * whether an "active" continuation marker is genuinely orphaned or merely
 * un-heartbeated. Unlike {@link snapshotLiveBackgroundAgents}, this preserves
 * the difference between "confirmed no live children" and "could not read a
 * reliable signal" (errorMessage / parent="unknown"), which the orphan
 * decision MUST NOT collapse — a transient scan failure must never be read as
 * "orphaned".
 */
async function probeBackgroundLiveness({
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

type BackgroundAgentPoller = { stop: () => void };

function startBackgroundAgentPoller({
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

export type AssistantClassification =
  | { kind: "done" }
  | { kind: "failed"; errorMessage: string }
  | { kind: "in-progress" }
  | { kind: "missing" };

function assistantErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const name = stringValue(error.name) ?? "Error";
  const data = isRecord(error.data) ? error.data : null;
  const message = data && "message" in data ? String(data.message) : stringValue(error.message);
  return message === undefined || message === name ? name : `${name}: ${message}`;
}

function isNonRetryableAssistantError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const data = isRecord(error.data) ? error.data : null;
  return data?.isRetryable === false;
}

async function classifyAssistantForMessage(
  client: OpencodeClient,
  repoDir: string,
  sessionID: string,
  parentMessageID: string,
): Promise<AssistantClassification> {
  let result;
  try {
    result = await client.session.messages({ sessionID, directory: repoDir });
  } catch {
    return { kind: "missing" };
  }
  if (result.error || !result.data) return { kind: "missing" };
  let tracked: AssistantClassification | undefined;
  let terminalError: AssistantClassification | undefined;
  for (const entry of result.data) {
    const info = entry.info;
    if (info.role !== "assistant") continue;
    const error = (info as { error?: unknown }).error;
    const errorMessage = assistantErrorMessage(error);
    if (errorMessage !== undefined && isNonRetryableAssistantError(error)) {
      terminalError ??= { kind: "failed", errorMessage };
    }
    if (info.parentID !== parentMessageID) continue;
    if (errorMessage !== undefined) {
      tracked = { kind: "failed", errorMessage };
      continue;
    }
    tracked = info.time.completed !== undefined ? { kind: "done" } : { kind: "in-progress" };
  }
  if (terminalError !== undefined) return terminalError;
  return tracked ?? { kind: "missing" };
}

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
};

export async function reattachOpenCodeStep({
  state,
  stepIndex,
  client,
  repoDir,
  step,
  sessionID,
  messageID,
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

  try {
    const sub = await client.event.subscribe({ directory: repoDir }, { signal: ctrl.signal });
    if (!sub.stream) throw new Error("event.subscribe returned no stream");
    pushLine(`[looper] subscribed to events for reattach`);
    consumerPromise = consumeSessionEvents(sub.stream, sessionID, {
      pushLine,
      pushLines,
      onSessionError: (message) => {
        sessionEventError ??= new Error(`session.error: ${message}`);
      },
    }).catch((err) => {
      const error = toError(err);
      if (isAbortError(error)) return;
      pushLine(`[error] event consumer crashed during reattach: ${error.message}`);
    });
  } catch (error) {
    pushLine(`[error] reattach failed to subscribe: ${toError(error).message}`);
  }

  try {
    while (cancellationAction === null) {
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
      await Bun.sleep(REATTACH_STATUS_POLL_MS);
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
  if (classification.kind === "failed") {
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

  let consumerPromise: Promise<void> | undefined;
  let consumerError: Error | undefined;
  let sessionEventError: Error | undefined;
  let finalError: Error | undefined;
  let supervisorPromise: Promise<void> | undefined;
  let supervisorStopped = false;
  let watchdogStallReason: string | undefined;
  let lastEventAt = Date.now();
  let flushConsumer: (() => void) | undefined;

  try {
    let sid = cancellation.activeSessionID;
    if (sid === undefined) {
      pushLine(`[looper] creating session for ${step.name}`);
      const created = await client.session.create(
        { directory: repoDir, ...(step.agent ? { agent: step.agent } : {}) },
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
      onSessionError: (message) => {
        sessionEventError ??= new Error(`session.error: ${message}`);
      },
      onActivity: () => {
        lastEventAt = Date.now();
      },
      ...(onFirstAssistantContent ? { onFirstAssistantContent } : {}),
    });
    flushConsumer = consumer.flush;

    const subscribeStream = async (): Promise<AsyncIterable<Event> | undefined> => {
      const sc = new AbortController();
      subscription.ctrl = sc;
      const sub = await client.event.subscribe({ directory: repoDir }, { signal: sc.signal });
      return sub.stream ?? undefined;
    };

    const startConsume = (stream: AsyncIterable<Event>): void => {
      consumerPromise = consumer.consume(stream).catch((err) => {
        const error = toError(err);
        if (isAbortError(error)) return;
        consumerError = error;
        pushLine(`[error] event consumer crashed: ${error.message}`);
      });
    };

    let lastResubscribeAt = 0;
    const resubscribe = async (reason: string): Promise<boolean> => {
      if (supervisorStopped || cancellation.action !== null) return false;
      const sinceLast = Date.now() - lastResubscribeAt;
      if (sinceLast < EVENT_RESUBSCRIBE_BACKOFF_MS) await Bun.sleep(EVENT_RESUBSCRIBE_BACKOFF_MS - sinceLast);
      if (supervisorStopped || cancellation.action !== null) return false;
      lastResubscribeAt = Date.now();
      subscription.ctrl?.abort();
      if (consumerPromise) {
        await Promise.race([consumerPromise, Bun.sleep(EVENT_CONSUMER_CLOSE_TIMEOUT_MS)]).catch(() => undefined);
      }
      if (supervisorStopped || cancellation.action !== null) return false;
      const stream = await subscribeStream().catch(() => undefined);
      if (!stream) {
        pushLine(`[looper] resubscribe failed to obtain a stream (${reason})`);
        return false;
      }
      try {
        const msgs = await client.session.messages({ sessionID: boundSessionID, directory: repoDir });
        if (!msgs.error && msgs.data) consumer.backfill(msgs.data);
      } catch {
        // backfill is best-effort; live events will continue to heal state
      }
      // Backfill first so the consumer's per-part length guards are in place
      // before live deltas from the new stream are appended. This prevents
      // overlapping replay from double-printing assistant text.
      lastEventAt = Date.now();
      startConsume(stream);
      pushLine(`[looper] resubscribed to events for ${boundSessionID} (${reason})`);
      return true;
    };

    const supervise = async (): Promise<void> => {
      while (!supervisorStopped && cancellation.action === null) {
        const current = consumerPromise ?? Promise.resolve();
        const outcome = await Promise.race([
          current.then(() => "ended" as const),
          Bun.sleep(EVENT_WATCHDOG_POLL_MS).then(() => "tick" as const),
        ]);
        if (supervisorStopped || cancellation.action !== null) break;

        const streamEnded = outcome === "ended";
        if (!streamEnded && Date.now() - lastEventAt < EVENT_STALL_THRESHOLD_MS) continue;

        let pending: boolean | undefined;
        try {
          pending = await sessionStillPending(client, repoDir, boundSessionID);
        } catch {
          pending = undefined;
        }
        if (supervisorStopped || cancellation.action !== null) break;

        if (pending === undefined) {
          if (streamEnded && !(await resubscribe("stream closed; session status unknown"))) {
            await Bun.sleep(EVENT_RESUBSCRIBE_BACKOFF_MS);
          }
          continue;
        }

        if (pending) {
          const reason = streamEnded ? "stream closed while session busy" : "no events while session busy";
          if (!(await resubscribe(reason))) await Bun.sleep(EVENT_RESUBSCRIBE_BACKOFF_MS);
          continue;
        }

        if (sentMessageID !== undefined) {
          const cls = await classifyAssistantForMessage(client, repoDir, boundSessionID, sentMessageID);
          if (supervisorStopped || cancellation.action !== null) break;
          if (cls.kind === "done" || cls.kind === "failed") {
            const silentSeconds = Math.round((Date.now() - lastEventAt) / 1000);
            const detail = cls.kind === "failed" ? `: ${cls.errorMessage}` : "";
            watchdogStallReason = `event watchdog: session ${boundSessionID} idle with assistant message ${cls.kind}${detail} but no events for ${silentSeconds}s; aborting prompt to finalize via reattach`;
            pushLine(`[looper] ${watchdogStallReason}`);
            ctrl.abort();
            break;
          }
          const inProgressReason = streamEnded
            ? "stream closed; assistant still in-progress"
            : "stream stalled; assistant still in-progress";
          if (!(await resubscribe(inProgressReason))) {
            await Bun.sleep(EVENT_RESUBSCRIBE_BACKOFF_MS);
          }
          continue;
        }

        if (streamEnded && !(await resubscribe("stream closed before prompt"))) {
          await Bun.sleep(EVENT_RESUBSCRIBE_BACKOFF_MS);
        }
      }
    };

    const stream0 = await subscribeStream();
    if (!stream0) throw new Error("event.subscribe returned no stream");
    pushLine(`[looper] subscribed to events`);
    lastEventAt = Date.now();
    startConsume(stream0);

    const model = parseModel(step.model);
    const variant = step.variant || undefined;
    const agent = step.agent || undefined;
    const messageID = createOpencodeID("msg");
    sentMessageID = messageID;
    onSessionBound?.({ sessionID: sid, messageID });
    supervisorPromise = supervise();
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
    supervisorStopped = true;
    subscription.ctrl?.abort();
    ctrl.abort();
    if (supervisorPromise) {
      await Promise.race([supervisorPromise, Bun.sleep(EVENT_CONSUMER_CLOSE_TIMEOUT_MS)]).catch(() => undefined);
    }
    if (consumerPromise) {
      let timedOut = false;
      await Promise.race([
        consumerPromise,
        Bun.sleep(EVENT_CONSUMER_CLOSE_TIMEOUT_MS).then(() => {
          timedOut = true;
        }),
      ]).catch(() => undefined);
      if (timedOut) pushLine(`[looper] event stream did not close within ${EVENT_CONSUMER_CLOSE_TIMEOUT_MS}ms; continuing`);
    }
    flushConsumer?.();
  }

  if (finalError === undefined && cancellation.action === null && consumerError !== undefined) {
    finalError = consumerError;
  }
  if (finalError === undefined && cancellation.action === null && sessionEventError !== undefined) {
    finalError = sessionEventError;
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
