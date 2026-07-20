import { renameSync } from "node:fs";
import { join } from "node:path";

import type { OscillationVerdict, StoryTransitionRecord } from "./adjudication-detection.ts";
import {
  regularFileExists,
  requireConfigDir,
  tolerantRead,
  tolerantRm,
  writeFileAtomically,
} from "./state-files.ts";

const ADJUDICATE_FILE_NAME = ".looper-adjudicate";
const PRD_HISTORY_FILE_NAME = ".looper-prd-history.json";
const ADJUDICATE_SESSION_FILE_NAME = ".looper-adjudicate-session.json";

export type AdjudicateSession = {
  readonly sessionID: string;
  readonly messageID?: string;
};

function adjudicateMarkerPath(): string {
  return join(requireConfigDir(), ADJUDICATE_FILE_NAME);
}

function prdHistoryPath(): string {
  return join(requireConfigDir(), PRD_HISTORY_FILE_NAME);
}

function adjudicateSessionPath(): string {
  return join(requireConfigDir(), ADJUDICATE_SESSION_FILE_NAME);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTransition(value: unknown): StoryTransitionRecord | null {
  if (!isRecord(value)) return null;
  const storyId = value["storyId"];
  const from = value["from"];
  const to = value["to"];
  const iteration = value["iteration"];
  const stepName = value["stepName"];
  const at = value["at"];
  if (typeof storyId !== "string" || storyId.length === 0) return null;
  if (typeof from !== "boolean" || typeof to !== "boolean") return null;
  if (typeof iteration !== "number" || !Number.isInteger(iteration)) return null;
  if (typeof stepName !== "string" || stepName.length === 0) return null;
  if (typeof at !== "string" || at.length === 0) return null;
  return { storyId, from, to, iteration, stepName, at };
}

/**
 * The persisted history file. `adjudicatedThrough` is the count of leading
 * `records` that a completed adjudication already resolved: detection only
 * considers records *after* this watermark, so a resolved oscillation cannot
 * retrigger from its own historical flips, while the full trail is retained on
 * disk for forensics.
 */
type PrdHistoryFile = {
  readonly records: readonly StoryTransitionRecord[];
  readonly adjudicatedThrough: number;
};

type HistoryFileParse =
  | { readonly kind: "empty" }
  | { readonly kind: "ok"; readonly file: PrdHistoryFile }
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
  return parseHistoryContent(tolerantRead(prdHistoryPath()));
}

function writeHistoryFile(file: PrdHistoryFile): void {
  writeFileAtomically(prdHistoryPath(), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Move a corrupt history file aside so a normal append never destroys it.
 * Returns whether the original path is now free to receive a fresh file; on
 * rename failure the original is preserved in place and the caller skips its
 * write rather than overwriting unreadable forensic data.
 */
function quarantineCorruptHistory(): boolean {
  const path = prdHistoryPath();
  const quarantinePath = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, quarantinePath);
    console.error(`[looper] adjudication: corrupt PRD history detected; moved original to ${quarantinePath}`);
    return true;
  } catch {
    console.error("[looper] adjudication: corrupt PRD history detected; could not quarantine it, skipping this update");
    return false;
  }
}

export function writeAdjudicateMarker(reason: string): void {
  writeFileAtomically(adjudicateMarkerPath(), reason);
}

export function adjudicateMarkerExists(): boolean {
  return regularFileExists(adjudicateMarkerPath());
}

export function readAdjudicateMarker(): string | null {
  return tolerantRead(adjudicateMarkerPath());
}

export function clearAdjudicateMarker(): void {
  tolerantRm(adjudicateMarkerPath());
}

export function appendPrdHistory(records: readonly StoryTransitionRecord[]): void {
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
export function readPrdHistory(): StoryTransitionRecord[] {
  const parse = readHistoryFile();
  return parse.kind === "ok" ? [...parse.file.records] : [];
}

/** Only transitions after the last completed adjudication (detection view). */
export function readActivePrdHistory(): StoryTransitionRecord[] {
  const parse = readHistoryFile();
  return parse.kind === "ok" ? parse.file.records.slice(parse.file.adjudicatedThrough) : [];
}

/**
 * Advance the watermark so every transition recorded so far is considered
 * resolved. Called only when an adjudication completes successfully; records
 * are retained, but they no longer count toward future oscillation detection.
 */
export function markPrdHistoryAdjudicated(): void {
  const parse = readHistoryFile();
  if (parse.kind === "empty") return;
  if (parse.kind === "corrupt") {
    quarantineCorruptHistory();
    return;
  }
  writeHistoryFile({ records: parse.file.records, adjudicatedThrough: parse.file.records.length });
}

export function clearPrdHistory(): void {
  tolerantRm(prdHistoryPath());
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
    `${JSON.stringify(session.messageID === undefined ? { sessionID: session.sessionID } : { sessionID: session.sessionID, messageID: session.messageID })}\n`,
  );
}

export function readAdjudicateSession(): AdjudicateSession | null {
  const content = tolerantRead(adjudicateSessionPath());
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || typeof parsed["sessionID"] !== "string" || parsed["sessionID"].length === 0) return null;
    const messageID = parsed["messageID"];
    return {
      sessionID: parsed["sessionID"],
      ...(typeof messageID === "string" && messageID.length > 0 ? { messageID } : {}),
    };
  } catch {
    return null;
  }
}

export function clearAdjudicateSession(): void {
  tolerantRm(adjudicateSessionPath());
}

export function buildAdjudicateReason(verdict: Extract<OscillationVerdict, { oscillating: true }>): string {
  const flipCount = verdict.trail.filter((transition) => transition.from && !transition.to).length;
  const trailLines = verdict.trail.map(
    (transition) =>
      `  - iteration ${transition.iteration} step ${transition.stepName}: ${transition.from}->${transition.to} at ${transition.at}`,
  );
  return [
    `PRD oscillation detected: story ${verdict.storyId} flipped passes true->false ${flipCount} times.`,
    ...trailLines,
    "An adjudication step should resolve the contract conflict; see .looper-prd-history.json.",
  ].join("\n");
}
