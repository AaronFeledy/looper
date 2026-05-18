import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
  const path = join(continuationDir(repoDir), `${sessionID}.json`);
  const direct = readContinuationRecordFromPath(path, `${sessionID}.json`);
  if (direct !== null && direct.sessionID === sessionID) return direct;
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
    consumerPromise = consumeSessionEvents(sub.stream, sid, { pushLine, pushLines }).catch((err) => {
      const error = toError(err);
      if (isAbortError(error)) return;
      consumerError = error;
      pushLine(`[error] event consumer crashed: ${error.message}`);
    });

    const model = parseModel(step.model);
    const variant = step.variant || undefined;
    pushLine(`[looper] sending prompt (agent=${step.agent}${model ? ` model=${model.providerID}/${model.modelID}` : ""}${variant ? ` variant=${variant}` : ""})`);
    const result = await client.session.prompt(
      {
        sessionID: sid,
        directory: repoDir,
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
      return { status: "waiting", sessionID: record.sessionID };
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

  return { status, sessionID: cancellation.activeSessionID };
}
