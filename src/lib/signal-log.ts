import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { tolerantRm } from "./state-files.ts";
import type { StoryPhase } from "./story-state-files.ts";
import { isValidPhase } from "./story-state-files.ts";

export const SIGNAL_LOG_FILE_NAME = ".looper-signals.jsonl";

export type SignalLogKind =
  | "adjudicate"
  | "stop"
  | "stop-after-iteration"
  | "story-phase"
  | "blocked"
  | "no-op";

export type SignalLogRecord = {
  readonly at: string;
  readonly kind: SignalLogKind;
  readonly storyId?: string;
  readonly phase?: StoryPhase;
  readonly reason?: string;
};

export type AppendSignalInput = {
  readonly kind: SignalLogKind;
  readonly storyId?: string;
  readonly phase?: StoryPhase;
  readonly reason?: string;
  /** Override timestamp (tests). Defaults to now. */
  readonly at?: string;
};

function signalLogPath(configDir: string): string {
  return join(configDir, SIGNAL_LOG_FILE_NAME);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SIGNAL_KINDS = new Set<string>([
  "adjudicate",
  "stop",
  "stop-after-iteration",
  "story-phase",
  "blocked",
  "no-op",
]);

function parseSignalLogLine(line: string): SignalLogRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // no-excuse-ok: catch -- malformed JSONL lines are skipped by contract
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const at = parsed["at"];
  const kind = parsed["kind"];
  if (typeof at !== "string" || at.length === 0) return undefined;
  if (typeof kind !== "string" || !SIGNAL_KINDS.has(kind)) return undefined;

  const storyIdRaw = parsed["storyId"];
  const phaseRaw = parsed["phase"];
  const reasonRaw = parsed["reason"];
  const storyId = typeof storyIdRaw === "string" && storyIdRaw.length > 0 ? storyIdRaw : undefined;
  const phase =
    typeof phaseRaw === "string" && isValidPhase(phaseRaw) ? phaseRaw : undefined;
  const reason = typeof reasonRaw === "string" && reasonRaw.length > 0 ? reasonRaw : undefined;

  return {
    at,
    kind: kind as SignalLogKind,
    ...(storyId !== undefined ? { storyId } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * Append one signal record as JSONL. Mode 0600; write failures are diagnostic-only
 * (mirrors permission-audit). Never throws.
 */
export function appendSignal(
  configDir: string,
  record: AppendSignalInput,
  onError: (message: string) => void = () => {},
): void {
  const path = signalLogPath(configDir);
  try {
    const entry: SignalLogRecord = {
      at: record.at ?? new Date().toISOString(),
      kind: record.kind,
      ...(record.storyId !== undefined ? { storyId: record.storyId } : {}),
      ...(record.phase !== undefined ? { phase: record.phase } : {}),
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
    };
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    // no-excuse-ok: catch -- audit/log write failures must not fail the signal
    const message = error instanceof Error ? error.message : String(error);
    onError(`[looper] signal log write failed: ${message}`);
  }
}

/**
 * Read signal records at or after `atMs` (inclusive). Malformed lines are skipped.
 * Missing/unreadable file → empty array (never throws on missing).
 */
export function readSignalsSince(configDir: string, atMs: number): SignalLogRecord[] {
  let raw: string;
  try {
    raw = readFileSync(signalLogPath(configDir), "utf8");
  } catch (error) {
    // no-excuse-ok: catch -- missing log is an empty history
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return [];
    }
    throw error;
  }
  const out: SignalLogRecord[] = [];
  for (const line of raw.split("\n")) {
    const record = parseSignalLogLine(line);
    if (record === undefined) continue;
    const ts = Date.parse(record.at);
    if (!Number.isFinite(ts) || ts < atMs) continue;
    out.push(record);
  }
  return out;
}

export function clearSignalLog(configDir: string): void {
  tolerantRm(signalLogPath(configDir));
}
