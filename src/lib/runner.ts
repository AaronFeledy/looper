import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { OpencodeClient, SessionStatus } from "@opencode-ai/sdk/v2";

import { consumeSessionEvents } from "./event-consumer.ts";
import { notify, pushAgentLine, pushStepOutputLine, pushStepOutputLines, setStepSessionID, syncSelectionToActiveStep, type LoopState } from "./state.ts";
import { stopFileExists } from "./state-files.ts";

export type Step = {
  name: string;
  agent: string;
  variant: string;
  model: string;
  prompt: string;
  prefix?: string;
  suffix?: string;
  args?: string[];
};

export type StepResult = "done" | "failed" | "skipped" | "restart" | "waiting";

export type StepRunResult = {
  status: StepResult;
  sessionID?: string;
  errorMessage?: string;
  messageID?: string;
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

export type ContinuationWaitResult = "idle" | "stopped" | "skipped" | "restart" | "stale" | "timeout";

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

export type RunOpenCodeStepOptions = {
  state: LoopState;
  stepIndex: number;
  prompt: string;
  client: OpencodeClient;
  repoDir: string;
  step: Step;
  sessionID?: string;
};

function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash === -1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

const ID_BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdTimestamp = 0;
let idCounter = 0;

function createOpencodeID(prefix: string): string {
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
  return join(repoDir, ".sisyphus", "run-continuation");
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

async function sessionStillPending(client: OpencodeClient, repoDir: string, sessionID: string): Promise<boolean> {
  const result = await client.session.status({ directory: repoDir });
  if (result.error) return false;
  return isPendingSessionStatus(result.data?.[sessionID]);
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
    const record = sessionID === undefined
      ? readActiveProjectContinuationRecord(repoDir, startedAt)
      : readProjectContinuationRecord(repoDir, sessionID);
    if (record !== null && continuationTime(record) >= startedAt - CONTINUATION_START_SKEW_MS) {
      if (record.source.state === "active") return record;
      if (record.source.state === "idle") return null;
    }

    const now = Date.now();
    if (sessionID !== undefined && now >= nextStatusPoll) {
      nextStatusPoll = now + CONTINUATION_STATUS_POLL_MS;
      if (await sessionStillPending(client, repoDir, sessionID)) {
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
    const record = readProjectContinuationRecord(repoDir, sessionID);
    if (record !== null) {
      if (record.source.state === "active") return record;
      if (record.source.state === "idle") return null;
    }

    const now = Date.now();
    if (now >= nextStatusPoll) {
      nextStatusPoll = now + CONTINUATION_STATUS_POLL_MS;
      if (await sessionStillPending(client, repoDir, sessionID)) {
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

function setContinuationStatus(state: LoopState, stepIndex: number, record: RunContinuationRecord): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  step.status = "waiting";
  step.statusMessage = `bg ${record.source.state}`;
  notify();
}

export async function waitForLoopContinuationIdle({
  state,
  client,
  stepIndex,
  repoDir,
  sessionID,
}: {
  state: LoopState;
  client: OpencodeClient;
  stepIndex: number;
  repoDir: string;
  sessionID: string;
}): Promise<ContinuationWaitResult> {
  const startedAt = Date.now();

  while (true) {
    if (state.restartRequested) return "restart";
    if (state.skipRequested) return "skipped";
    if (state.quitting || stopFileExists()) return "stopped";

    const record = readProjectContinuationRecord(repoDir, sessionID);

    if (record !== null && record.source.state === "idle") {
      setContinuationStatus(state, stepIndex, record);
      logContinuationState(state, stepIndex, record, "background tasks idle");
      return "idle";
    }

    if (record === null) {
      // Record vanished or never appeared. Only call it "idle" once the SDK
      // confirms the session is no longer pending; otherwise keep polling.
      if (!(await sessionStillPending(client, repoDir, sessionID))) return "idle";
    } else {
      setContinuationStatus(state, stepIndex, record);
      const updatedAt = Date.parse(record.source.updatedAt);
      if (Number.isFinite(updatedAt) && Date.now() - updatedAt > CONTINUATION_STALE_MS) return "stale";
    }

    if (Date.now() - startedAt > CONTINUATION_MAX_WAIT_MS) return "timeout";

    await Bun.sleep(CONTINUATION_POLL_MS);
  }
}

export type AssistantClassification =
  | { kind: "done" }
  | { kind: "failed"; errorMessage: string }
  | { kind: "in-progress" }
  | { kind: "missing" };

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
  for (const entry of result.data) {
    const info = entry.info;
    if (info.role !== "assistant") continue;
    if (info.parentID !== parentMessageID) continue;
    if (info.error) {
      const err = info.error;
      const data = err.data;
      const message =
        data && typeof data === "object" && "message" in data
          ? String((data as { message: unknown }).message)
          : err.name;
      return { kind: "failed", errorMessage: `${err.name}: ${message}` };
    }
    if (info.time.completed !== undefined) return { kind: "done" };
    return { kind: "in-progress" };
  }
  return { kind: "missing" };
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

  state.activeStepIndex = stepIndex;
  syncSelectionToActiveStep(state);
  activeStep.status = "running";
  activeStep.statusMessage = "reattaching";
  activeStep.startedAt = Date.now();
  activeStep.finishedAt = undefined;
  setStepSessionID(state, stepIndex, sessionID);
  notify();

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
      void client.session.abort({ sessionID, directory: repoDir }).catch(() => undefined);
    }
    ctrl.abort();
  };

  const watcher = setInterval(() => {
    if (cancellationAction !== null) return;
    if (state.restartRequested) requestCancellation("restart");
    else if (state.skipRequested || state.quitting || stopFileExists()) requestCancellation("skip");
  }, 100);

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

  if (sessionEventError !== undefined && cancellationAction === null) {
    pushLine(`[error] reattach: ${sessionEventError.message}`);
    activeStep.status = "failed";
    activeStep.finishedAt = Date.now();
    state.activeStepIndex = null;
    notify();
    return {
      status: "failed",
      sessionID,
      messageID,
      errorMessage: sessionEventError.message,
    };
  }

  const finalize = (
    statusValue: StepResult,
    extras?: { errorMessage?: string; statusMessage?: string },
  ): StepRunResult => {
    if (statusValue === "restart") {
      activeStep.status = "pending";
      activeStep.statusMessage = undefined;
      activeStep.finishedAt = undefined;
    } else {
      activeStep.status = statusValue;
      activeStep.statusMessage = extras?.statusMessage;
      activeStep.finishedAt = Date.now();
    }
    state.activeStepIndex = null;
    notify();
    return {
      status: statusValue,
      sessionID,
      messageID,
      ...(extras?.errorMessage !== undefined ? { errorMessage: extras.errorMessage } : {}),
    };
  };

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
    const record = await waitForSessionLoopContinuationRecord({ client, repoDir, sessionID });
    if (record !== null) {
      setContinuationStatus(state, stepIndex, record);
      logContinuationState(state, stepIndex, record, "background tasks active after reattach");
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
}: RunOpenCodeStepOptions): Promise<StepRunResult> {
  const activeStep = state.steps[stepIndex];
  if (!activeStep) throw new Error(`missing state step at index ${stepIndex}`);
  const startedAt = Date.now();

  state.activeStepIndex = stepIndex;
  syncSelectionToActiveStep(state);
  activeStep.status = "running";
  activeStep.statusMessage = undefined;
  activeStep.startedAt = Date.now();
  activeStep.finishedAt = undefined;
  notify();

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
  const cancellation: { action: "skip" | "restart" | null; abortSent: boolean; activeSessionID: string | undefined } = {
    action: null,
    abortSent: false,
    activeSessionID: sessionID,
  };

  const persistSessionID = (sid: string) => {
    cancellation.activeSessionID = sid;
    setStepSessionID(state, stepIndex, sid);
  };

  if (sessionID !== undefined) persistSessionID(sessionID);

  const requestCancellation = (reason: "skip" | "restart") => {
    if (cancellation.action !== null) return;
    cancellation.action = reason;
    pushLine(`[looper] ${reason} requested for ${step.name}`);
    if (cancellation.activeSessionID !== undefined && !cancellation.abortSent) {
      cancellation.abortSent = true;
      const sid = cancellation.activeSessionID;
      void client.session.abort({ sessionID: sid, directory: repoDir }).catch(() => undefined);
    }
    ctrl.abort();
  };

  const watcher = setInterval(() => {
    if (cancellation.action !== null) return;
    if (state.restartRequested) requestCancellation("restart");
    else if (state.skipRequested || state.quitting || stopFileExists()) requestCancellation("skip");
  }, 100);

  let consumerPromise: Promise<void> | undefined;
  let consumerError: Error | undefined;
  let sessionEventError: Error | undefined;
  let finalError: Error | undefined;

  try {
    let sid = cancellation.activeSessionID;
    if (sid === undefined) {
      pushLine(`[looper] creating session for ${step.name}`);
      const created = await client.session.create(
        { directory: repoDir, agent: step.agent },
        { signal: ctrl.signal },
      );
      if (created.error) throw new Error(`session.create: ${formatRequestError(created.error)}`);
      const createdID = created.data?.id;
      if (!createdID) throw new Error("session.create returned no id");
      sid = createdID;
      persistSessionID(sid);
    }
    pushLine(`[looper] session=${sid}`);

    const sub = await client.event.subscribe(
      { directory: repoDir },
      { signal: ctrl.signal },
    );
    if (!sub.stream) throw new Error("event.subscribe returned no stream");
    pushLine(`[looper] subscribed to events`);
    consumerPromise = consumeSessionEvents(sub.stream, sid, {
      pushLine,
      pushLines,
      onSessionError: (message) => {
        sessionEventError ??= new Error(`session.error: ${message}`);
      },
    }).catch((err) => {
      const error = toError(err);
      if (isAbortError(error)) return;
      consumerError = error;
      pushLine(`[error] event consumer crashed: ${error.message}`);
    });

    const model = parseModel(step.model);
    const variant = step.variant || undefined;
    const messageID = createOpencodeID("msg");
    sentMessageID = messageID;
    pushLine(`[looper] sending prompt (agent=${step.agent}${model ? ` model=${model.providerID}/${model.modelID}` : ""}${variant ? ` variant=${variant}` : ""} messageID=${messageID})`);
    const result = await client.session.prompt(
      {
        sessionID: sid,
        directory: repoDir,
        messageID,
        parts: [{ type: "text", text: prompt }],
        agent: step.agent,
        ...(model ? { model } : {}),
        ...(variant ? { variant } : {}),
      },
      { signal: ctrl.signal },
    );
    if (result.error) throw new Error(`session.prompt: ${formatRequestError(result.error)}`);
    pushLine(`[looper] prompt completed`);
  } catch (error) {
    if (cancellation.action === null) {
      finalError = error instanceof Error ? error : new Error(String(error));
    }
  } finally {
    clearInterval(watcher);
    ctrl.abort();
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
    const record = await waitForActiveLoopContinuationRecord({
      client,
      repoDir,
      startedAt,
      sessionID: cancellation.activeSessionID,
    });
    if (record !== null) {
      setContinuationStatus(state, stepIndex, record);
      logContinuationState(state, stepIndex, record, "background tasks active after opencode exit");
      return { status: "waiting", sessionID: record.sessionID, ...(sentMessageID !== undefined ? { messageID: sentMessageID } : {}) };
    }
  }

  if (status === "restart") {
    activeStep.status = "pending";
    activeStep.statusMessage = undefined;
    activeStep.finishedAt = undefined;
  } else {
    activeStep.status = status;
    activeStep.statusMessage = undefined;
    activeStep.finishedAt = Date.now();
  }
  state.activeStepIndex = null;
  notify();

  return {
    status,
    sessionID: cancellation.activeSessionID,
    ...(status === "failed" && finalError ? { errorMessage: finalError.message } : {}),
    ...(sentMessageID !== undefined ? { messageID: sentMessageID } : {}),
  };
}
