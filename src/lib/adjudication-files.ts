import { renameSync } from "node:fs";
import { join } from "node:path";
import { clearAdjudicationRequest, parseAdjudicationRequest, readAdjudicationRequest, writeAdjudicationRequest, type AdjudicationRequest } from "../persistence/adjudication-request.ts";

import type { OscillationVerdict, StoryTransitionRecord } from "./adjudication-detection.ts";
import {
  regularFileExists,
  requireConfigDir,
  tolerantRead,
  tolerantRm,
  writeFileAtomically,
} from "./state-files.ts";
import { comparePhase, isValidPhase, type StoryPhase } from "./story-state-files.ts";

const ADJUDICATE_FILE_NAME = ".looper-adjudicate";
const PHASE_HISTORY_FILE_NAME = ".looper-phase-history.json";
/** Legacy name; only used to quarantine/migrate if present is not required — new writes use PHASE_HISTORY. */
const LEGACY_PRD_HISTORY_FILE_NAME = ".looper-prd-history.json";
const ADJUDICATE_SESSION_FILE_NAME = ".looper-adjudicate-session.json";
const ADJUDICATION_LOG_FILE_NAME = ".looper-adjudication-log.json";

/**
 * One completed adjudication: when it finished and the marker reason that
 * triggered it. Durable so gate scripts and prompts can distinguish "already
 * adjudicated, nothing new since" from a genuinely fresh escalation.
 */
export type AdjudicationCompletionRecord = {
  readonly at: string;
  readonly reason: string;
};

export type AdjudicateSession = {
  readonly sessionID: string;
  readonly messageID?: string;
  readonly request?: AdjudicationRequest;
};

export type AdjudicateSessionRead =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly session: AdjudicateSession }
  | { readonly kind: "corrupt" };

function adjudicateMarkerPath(): string {
  return join(requireConfigDir(), ADJUDICATE_FILE_NAME);
}

function phaseHistoryPath(): string {
  return join(requireConfigDir(), PHASE_HISTORY_FILE_NAME);
}

function adjudicateSessionPath(): string {
  return join(requireConfigDir(), ADJUDICATE_SESSION_FILE_NAME);
}

function adjudicationLogPath(): string {
  return join(requireConfigDir(), ADJUDICATION_LOG_FILE_NAME);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePhase(value: unknown): StoryPhase | null {
  return typeof value === "string" && isValidPhase(value) ? value : null;
}

function parseTransition(value: unknown): StoryTransitionRecord | null {
  if (!isRecord(value)) return null;
  const storyId = value["storyId"];
  const from = parsePhase(value["from"]);
  const to = parsePhase(value["to"]);
  const iteration = value["iteration"];
  const stepName = value["stepName"];
  const at = value["at"];
  const source = value["source"];
  if (typeof storyId !== "string" || storyId.length === 0) return null;
  if (from === null || to === null) return null;
  if (typeof iteration !== "number" || !Number.isInteger(iteration)) return null;
  if (typeof stepName !== "string" || stepName.length === 0) return null;
  if (typeof at !== "string" || at.length === 0) return null;
  if (source !== "signal" && source !== "engine") return null;
  return { storyId, from, to, iteration, stepName, at, source };
}

/**
 * The persisted history file. `adjudicatedThrough` is the count of leading
 * `records` that a completed adjudication already resolved: detection only
 * considers records *after* this watermark, so a resolved oscillation cannot
 * retrigger from its own historical flips, while the full trail is retained on
 * disk for forensics.
 */
type PhaseHistoryFile = {
  readonly records: readonly StoryTransitionRecord[];
  readonly adjudicatedThrough: number;
};

type HistoryFileParse =
  | { readonly kind: "empty" }
  | { readonly kind: "ok"; readonly file: PhaseHistoryFile }
  | { readonly kind: "corrupt" };

/**
 * Distinguish a genuinely absent history file (safe to treat as empty) from a
 * present-but-unreadable one (must NOT be silently overwritten, or forensic
 * evidence is destroyed outside `--fresh`). Callers that mutate quarantine the
 * corrupt original before writing; pure readers fall back to an empty view.
 */
function parseHistoryContent(content: string | null): HistoryFileParse {
  if (content === null) return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["records"])) return { kind: "corrupt" };
  const records: StoryTransitionRecord[] = [];
  for (const valueRecord of parsed["records"]) {
    const transition = parseTransition(valueRecord);
    if (transition === null) return { kind: "corrupt" };
    records.push(transition);
  }
  const rawThrough = parsed["adjudicatedThrough"];
  const adjudicatedThrough =
    typeof rawThrough === "number" && Number.isInteger(rawThrough) && rawThrough >= 0 && rawThrough <= records.length
      ? rawThrough
      : 0;
  return { kind: "ok", file: { records, adjudicatedThrough } };
}

function readHistoryFile(): HistoryFileParse {
  return parseHistoryContent(tolerantRead(phaseHistoryPath()));
}

function writeHistoryFile(file: PhaseHistoryFile): void {
  writeFileAtomically(phaseHistoryPath(), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Move a corrupt history file aside so a normal append never destroys it.
 * Returns whether the original path is now free to receive a fresh file; on
 * rename failure the original is preserved in place and the caller skips its
 * write rather than overwriting unreadable forensic data.
 */
function quarantineCorruptHistory(): boolean {
  const path = phaseHistoryPath();
  const quarantinePath = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, quarantinePath);
    console.error(`[looper] adjudication: corrupt phase history detected; moved original to ${quarantinePath}`);
    return true;
  } catch {
    console.error("[looper] adjudication: corrupt phase history detected; could not quarantine it, skipping this update");
    return false;
  }
}

export function writeAdjudicateMarker(reason: string): void {
  writeAdjudicationRequest(reason);
}

export function adjudicateMarkerExists(): boolean {
  return regularFileExists(adjudicateMarkerPath());
}

export function readAdjudicateMarker(): string | null {
  return readAdjudicationRequest()?.reason ?? null;
}

export function clearAdjudicateMarker(): void {
  clearAdjudicationRequest();
}

export function appendPhaseHistory(records: readonly StoryTransitionRecord[]): void {
  if (records.length === 0) return;
  const parse = readHistoryFile();
  if (parse.kind === "corrupt") {
    if (!quarantineCorruptHistory()) return;
    writeHistoryFile({ records: [...records], adjudicatedThrough: 0 });
    return;
  }
  const base = parse.kind === "ok" ? parse.file : { records: [], adjudicatedThrough: 0 };
  writeHistoryFile({ records: [...base.records, ...records], adjudicatedThrough: base.adjudicatedThrough });
}


/** Every recorded transition (forensic view). */
export function readPhaseHistory(): StoryTransitionRecord[] {
  const parse = readHistoryFile();
  return parse.kind === "ok" ? [...parse.file.records] : [];
}


/** Only transitions after the last completed adjudication (detection view). */
export function readActivePhaseHistory(): StoryTransitionRecord[] {
  const parse = readHistoryFile();
  return parse.kind === "ok" ? parse.file.records.slice(parse.file.adjudicatedThrough) : [];
}


/**
 * Advance the watermark so every transition recorded so far is considered
 * resolved. Called only when an adjudication completes successfully; records
 * are retained, but they no longer count toward future oscillation detection.
 */
export function markPhaseHistoryAdjudicated(): void {
  const parse = readHistoryFile();
  if (parse.kind === "empty") return;
  if (parse.kind === "corrupt") {
    quarantineCorruptHistory();
    return;
  }
  writeHistoryFile({ records: parse.file.records, adjudicatedThrough: parse.file.records.length });
}


export function clearPhaseHistory(): void {
  tolerantRm(phaseHistoryPath());
  // Also clear any leftover legacy file so --fresh does not leave stale passes history.
  tolerantRm(join(requireConfigDir(), LEGACY_PRD_HISTORY_FILE_NAME));
}


function parseCompletionRecord(value: unknown): AdjudicationCompletionRecord | null {
  if (!isRecord(value)) return null;
  const at = value["at"];
  const reason = value["reason"];
  if (typeof at !== "string" || at.length === 0) return null;
  if (typeof reason !== "string") return null;
  return { at, reason };
}

type AdjudicationLogParse =
  | { readonly kind: "empty" }
  | { readonly kind: "ok"; readonly records: AdjudicationCompletionRecord[] }
  | { readonly kind: "corrupt" };

function parseAdjudicationLogContent(content: string | null): AdjudicationLogParse {
  if (content === null) return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: "corrupt" };
  }
  if (!Array.isArray(parsed)) return { kind: "corrupt" };
  const records: AdjudicationCompletionRecord[] = [];
  for (const value of parsed) {
    const record = parseCompletionRecord(value);
    if (record === null) return { kind: "corrupt" };
    records.push(record);
  }
  return { kind: "ok", records };
}

function readAdjudicationLogFile(): AdjudicationLogParse {
  return parseAdjudicationLogContent(tolerantRead(adjudicationLogPath()));
}

function quarantineCorruptAdjudicationLog(): boolean {
  const path = adjudicationLogPath();
  const quarantinePath = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, quarantinePath);
    console.error(`[looper] adjudication: corrupt adjudication log detected; moved original to ${quarantinePath}`);
    return true;
  } catch {
    console.error("[looper] adjudication: corrupt adjudication log detected; could not quarantine it, skipping this update");
    return false;
  }
}

export function readAdjudicationLog(): AdjudicationCompletionRecord[] {
  const parse = readAdjudicationLogFile();
  return parse.kind === "ok" ? parse.records : [];
}

export function appendAdjudicationCompletion(record: AdjudicationCompletionRecord): void {
  const parse = readAdjudicationLogFile();
  if (parse.kind === "corrupt") {
    if (!quarantineCorruptAdjudicationLog()) return;
    writeAdjudicationLogFile([record]);
    return;
  }
  const base = parse.kind === "ok" ? parse.records : [];
  writeAdjudicationLogFile([...base, record]);
}

function writeAdjudicationLogFile(records: readonly AdjudicationCompletionRecord[]): void {
  writeFileAtomically(adjudicationLogPath(), `${JSON.stringify(records, null, 2)}\n`);
}

export function clearAdjudicationLog(): void {
  tolerantRm(adjudicationLogPath());
}

/**
 * The in-flight adjudicator session, persisted before its prompt is dispatched
 * so a crash mid-adjudication leaves a durable record the next run can
 * confirm-stop before launching a fresh (overlapping) adjudicator generation.
 * It is NOT the resumable step pointer: the adjudicate row is never a resume
 * position; the marker plus this record are the durable adjudication signal.
 */
export function writeAdjudicateSession(session: AdjudicateSession): void {
  writeFileAtomically(
    adjudicateSessionPath(),
    `${JSON.stringify(session)}\n`,
  );
}

export function readAdjudicateSession(): AdjudicateSessionRead {
  const content = tolerantRead(adjudicateSessionPath());
  if (content === null) return { kind: "absent" };
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || typeof parsed["sessionID"] !== "string" || parsed["sessionID"].length === 0) return { kind: "corrupt" };
    const messageID = parsed["messageID"];
    const request = parseAdjudicationRequest(parsed["request"]);
    if (parsed["request"] !== undefined && request === undefined) return { kind: "corrupt" };
    return {
      kind: "ok",
      session: {
        sessionID: parsed["sessionID"],
        ...(typeof messageID === "string" && messageID.length > 0 ? { messageID } : {}),
        ...(request !== undefined ? { request } : {}),
      },
    };
  } catch {
    return { kind: "corrupt" };
  }
}

export function clearAdjudicateSession(): void {
  tolerantRm(adjudicateSessionPath());
}

export function buildAdjudicateReason(verdict: Extract<OscillationVerdict, { oscillating: true }>): string {
  const demotions = verdict.trail.filter(
    (transition) => transition.source === "signal" && comparePhase(transition.to, transition.from) < 0,
  );
  const demotionCount = demotions.length;
  const demotionSummary =
    demotions.length === 0
      ? ""
      : ` (${demotions.map((t) => `${t.from}→${t.to}`).join(", ")})`;
  const trailLines = verdict.trail.map(
    (transition) =>
      `  - iteration ${transition.iteration} step ${transition.stepName}: ${transition.from}->${transition.to} (${transition.source}) at ${transition.at}`,
  );
  return [
    `Phase oscillation detected: story ${verdict.storyId} was demoted ${demotionCount} times${demotionSummary}.`,
    ...trailLines,
    "An adjudication step should resolve the contract conflict; see .looper-phase-history.json.",
  ].join("\n");
}
