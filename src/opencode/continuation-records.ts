import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { isMissingPathError, isRecord, stringValue } from "./util.ts";

export const CONTINUATION_POLL_MS = 5_000;
export const CONTINUATION_MAX_WAIT_MS = 60 * 60 * 1000;
export const CONTINUATION_STALE_MS = 15 * 60 * 1000;
export const CONTINUATION_START_SKEW_MS = 5_000;
export const CONTINUATION_EXIT_GRACE_POLL_MS = 100;
export const CONTINUATION_STATUS_POLL_MS = 1_000;
export const REATTACH_STATUS_POLL_MS = 2_000;
export const REATTACH_MAX_WAIT_MS = 60 * 60 * 1000;
export const CONTINUATION_MAX_FILES = 1_000;
export const CONTINUATION_MAX_BYTES = 64 * 1024;
export const EVENT_CONSUMER_CLOSE_TIMEOUT_MS = 2_000;

export type ContinuationState = "active" | "idle";

export type BackgroundTaskSource = {
  state: ContinuationState;
  reason?: string;
  updatedAt: string;
};

export type RunContinuationRecord = {
  sessionID: string;
  updatedAt: string;
  source: BackgroundTaskSource;
};

function parseBackgroundTaskSource(value: unknown): BackgroundTaskSource | null {
  if (!isRecord(value)) return null;

  const state = value.state;
  if (state !== "active" && state !== "idle") return null;

  const updatedAt = stringValue(value.updatedAt);
  if (updatedAt === undefined) return null;

  const reason = stringValue(value.reason);
  return reason === undefined ? { state, updatedAt } : { state, updatedAt, reason };
}

export function parseContinuationRecord(content: string): RunContinuationRecord | null {
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

export function continuationTime(record: RunContinuationRecord): number {
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

export function continuationDir(repoDir: string): string {
  return join(repoDir, ".omo", "run-continuation");
}

export function isSafeSessionID(sessionID: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionID);
}

export function readProjectContinuationRecords(repoDir: string): RunContinuationRecord[] {
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

export function newestRecord(records: RunContinuationRecord[]): RunContinuationRecord | null {
  return records.sort((left, right) => continuationTime(right) - continuationTime(left))[0] ?? null;
}

export function readProjectContinuationRecord(repoDir: string, sessionID: string): RunContinuationRecord | null {
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

export function readActiveProjectContinuationRecord(repoDir: string, startedAt: number): RunContinuationRecord | null {
  const minTime = startedAt - CONTINUATION_START_SKEW_MS;
  return newestRecord(
    readProjectContinuationRecords(repoDir).filter(
      (record) => record.source.state === "active" && continuationTime(record) >= minTime,
    ),
  );
}
