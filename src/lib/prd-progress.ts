import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { tolerantRead, writeFileAtomically } from "./state-files.ts";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatProgressTimestamp(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

const GATE_SKIP_MARKER = "- [looper] gate skipped ";

function gateSkipLine(stepName: string, reason: string): string {
  return `${GATE_SKIP_MARKER}${stepName}: ${reason}`;
}

export function formatGateSkipProgressEntry(input: {
  readonly stepName: string;
  readonly reason: string;
  readonly at?: Date;
}): string {
  const timestamp = formatProgressTimestamp(input.at ?? new Date());
  return `## ${timestamp} - ${input.stepName}\n${gateSkipLine(input.stepName, input.reason)}\n---\n`;
}

/**
 * A gate stays shut for as long as its condition holds, so an unchanged loop
 * re-reports the same skip every iteration: one entry per gated step per
 * iteration, unbounded. An observed stalled run appended 21 identical entries
 * in four minutes, and gate skips ended up a quarter of the progress file.
 *
 * Suppress a skip whose exact line already appears in the unbroken run of
 * gate-skip entries at the end of the file -- the reader has been told, and
 * nothing has happened since. Any other entry (real agent work, a blocked
 * step) closes that window, so the first skip after every real event is still
 * recorded. A body containing its own `---` rule only splits the window early,
 * which appends: this fails toward keeping entries, never toward dropping a
 * skip the reader has not seen.
 */
function gateSkipAlreadyReported(existing: string, line: string): boolean {
  const blocks = existing.split(/^---[ \t]*$/m);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]?.trim();
    if (block === undefined || block.length === 0) continue;
    // Whole-line comparisons on purpose. A substring test lets a shorter reason
    // match a longer one that merely starts with it -- `exited with code 1` is a
    // prefix of `exited with code 10` -- and would suppress a skip the reader
    // has never seen. The same applies to spotting a gate-skip block at all:
    // anchoring to the start of a line keeps agent prose that happens to quote
    // the marker from silently extending the suppression window.
    const lines = block.split("\n").map((entry) => entry.trim());
    if (!lines.some((entry) => entry.startsWith(GATE_SKIP_MARKER))) return false;
    if (lines.includes(line)) return true;
  }
  return false;
}

export function resolveProgressFilePath(progress: string, repoDir: string): string {
  return isAbsolute(progress) ? progress : join(repoDir, progress);
}

export type AppendProgressResult = { readonly appended: true } | { readonly appended: false; readonly error: string };

function appendProgressEntry(
  progressPath: string,
  entry: string,
  suppress?: (existing: string) => boolean,
): AppendProgressResult {
  try {
    mkdirSync(dirname(progressPath), { recursive: true });
    const existing = tolerantRead(progressPath) ?? "";
    // A suppressed entry reports success: the file already carries this fact,
    // so the caller has no failure to warn about.
    if (suppress !== undefined && suppress(existing)) return { appended: true };
    const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
    const separator = prefix.length === 0 || prefix.endsWith("\n\n") || prefix.endsWith("---\n") ? "" : "\n";
    writeFileAtomically(progressPath, `${prefix}${separator}${entry}`);
    return { appended: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { appended: false, error: message };
  }
}

export function appendGateSkipToProgress(input: {
  readonly progressPath: string;
  readonly stepName: string;
  readonly reason: string;
  readonly at?: Date;
}): AppendProgressResult {
  const entry = formatGateSkipProgressEntry({
    stepName: input.stepName,
    reason: input.reason,
    ...(input.at !== undefined ? { at: input.at } : {}),
  });
  const line = gateSkipLine(input.stepName, input.reason);
  return appendProgressEntry(input.progressPath, entry, (existing) => gateSkipAlreadyReported(existing, line));
}

export function appendHandbackStepToProgress(input: {
  readonly progressPath: string;
  readonly stepName: string;
  readonly phase: string;
  readonly reason: string;
  readonly at?: Date;
}): AppendProgressResult {
  const timestamp = formatProgressTimestamp(input.at ?? new Date());
  const entry = `## ${timestamp} - ${input.stepName}\n- [looper] ${input.stepName} handed the story back at ${input.phase}: ${input.reason}\n---\n`;
  return appendProgressEntry(input.progressPath, entry);
}

export function appendBlockedStepToProgress(input: {
  readonly progressPath: string;
  readonly stepName: string;
  readonly reason: string;
  readonly at?: Date;
}): AppendProgressResult {
  const timestamp = formatProgressTimestamp(input.at ?? new Date());
  const entry = `## ${timestamp} - ${input.stepName}\n- [looper] ${input.stepName} blocked: ${input.reason}\n---\n`;
  return appendProgressEntry(input.progressPath, entry);
}
