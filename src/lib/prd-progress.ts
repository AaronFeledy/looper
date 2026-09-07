import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { tolerantRead, writeFileAtomically } from "./state-files.ts";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatProgressTimestamp(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

export function formatGateSkipProgressEntry(input: {
  readonly stepName: string;
  readonly reason: string;
  readonly at?: Date;
}): string {
  const timestamp = formatProgressTimestamp(input.at ?? new Date());
  return `## ${timestamp} - ${input.stepName}\n- [looper] gate skipped ${input.stepName}: ${input.reason}\n---\n`;
}

export function resolveProgressFilePath(progress: string, repoDir: string): string {
  return isAbsolute(progress) ? progress : join(repoDir, progress);
}

export type AppendProgressResult = { readonly appended: true } | { readonly appended: false; readonly error: string };

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
  try {
    mkdirSync(dirname(input.progressPath), { recursive: true });
    const existing = tolerantRead(input.progressPath) ?? "";
    const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
    const separator = prefix.length === 0 || prefix.endsWith("\n\n") || prefix.endsWith("---\n") ? "" : "\n";
    writeFileAtomically(input.progressPath, `${prefix}${separator}${entry}`);
    return { appended: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { appended: false, error: message };
  }
}
