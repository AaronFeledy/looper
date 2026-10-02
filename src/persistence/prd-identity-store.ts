import { lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { UsageError } from "../lib/args.ts";
import { tolerantRead, writeFileAtomically } from "../lib/state-files.ts";
import { withFileTransaction } from "./file-transaction.ts";

export const PRD_IDENTITY_FILE = ".looper-prd-identity.json";
export const PRD_RESET_FILE = ".looper-prd-reset.json";
export const PRD_STATE_FILES = [
  ".looper-run.json", ".looper-resume-step.json", ".looper-story-state.json",
  ".looper-step-attempts.json", ".looper-adjudicate", ".looper-adjudicate-session.json",
  ".looper-phase-history.json", ".looper-prd-history.json", ".looper-adjudication-log.json",
  ".looper-agents.json", ".looper-signals.jsonl", ".looper-permission-log.jsonl",
  ".looper-stop", ".looper-stop-after-iteration", ".last-branch",
] as const;
export type PrdIdentity = { readonly version: 1; readonly prdDir: string | null; readonly serverUrl?: string; readonly writerProtocol?: 1 };
export type PrdStateSnapshot = ReadonlyMap<string, string>;

export function readPrdStateSnapshot(configDir: string): PrdStateSnapshot {
  const files = new Map<string, string>();
  for (const name of [...PRD_STATE_FILES, PRD_IDENTITY_FILE, PRD_RESET_FILE]) {
    const path = join(configDir, name);
    const text = tolerantRead(path);
    if (text === null) continue;
    if (!lstatSync(path).isFile()) throw new UsageError(`Refusing non-regular state file: ${path}`);
    files.set(name, text);
  }
  return files;
}

export function parsePrdIdentity(snapshot: PrdStateSnapshot): PrdIdentity | undefined {
  const raw = snapshot.get(PRD_IDENTITY_FILE);
  if (raw === undefined) return;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1
    || !("prdDir" in value) || (value.prdDir !== null && (typeof value.prdDir !== "string" || !isAbsolute(value.prdDir)))
    || ("serverUrl" in value && typeof value.serverUrl !== "string")
    || ("writerProtocol" in value && value.writerProtocol !== 1)) {
    throw new UsageError(`Invalid ${PRD_IDENTITY_FILE}; restore its valid association before proceeding`);
  }
  return { version: 1, prdDir: value.prdDir,
    ...("writerProtocol" in value && value.writerProtocol === 1 ? { writerProtocol: 1 } : {}),
    ...("serverUrl" in value && typeof value.serverUrl === "string" ? { serverUrl: value.serverUrl } : {}) };
}

export function normalizedPrdDir(repoDir: string, prdDir: string): string {
  return realpathSync(resolve(repoDir, prdDir));
}

export function commitPrdIdentity(input: {
  readonly configDir: string;
  readonly snapshot: PrdStateSnapshot;
  readonly identity: PrdIdentity;
  readonly reset: boolean;
  readonly fresh?: "preserve-stories" | "reset-stories";
  readonly assertReady?: () => void;
}): string | undefined {
  return withFileTransaction(input.configDir, () => {
    const current = readPrdStateSnapshot(input.configDir);
    if (current.size !== input.snapshot.size || [...current].some(([name, text]) => input.snapshot.get(name) !== text)) {
      throw new UsageError("Looper state changed during PRD reconciliation; retry after the other writer stops");
    }
    input.assertReady?.();
    const filesToRemove = PRD_STATE_FILES.filter(name => input.reset || (
      input.fresh !== undefined && name !== ".last-branch"
      && (name !== ".looper-story-state.json" || input.fresh === "reset-stories")
    ));
    let archiveDir: string | undefined;
    if ((input.reset && current.size > 0) || filesToRemove.some(name => current.has(name))) {
      archiveDir = join(input.configDir, ".looper-archive", `${Date.now()}-${crypto.randomUUID()}`);
      mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      for (const [name, text] of current) writeFileAtomically(join(archiveDir, name), text);
      writeFileAtomically(join(archiveDir, "manifest.json"), JSON.stringify({ version: 1, target: input.identity, files: [...current.keys()], removed: filesToRemove }));
      // A crash during the multi-file reset must never authorize a partial fresh run.
      writeFileAtomically(join(input.configDir, PRD_RESET_FILE), JSON.stringify({ archiveDir }));
      input.assertReady?.();
      for (const name of filesToRemove) if (current.has(name)) unlinkSync(join(input.configDir, name));
    }
    writeFileAtomically(join(input.configDir, PRD_IDENTITY_FILE), `${JSON.stringify(input.identity)}\n`);
    if (archiveDir !== undefined) unlinkSync(join(input.configDir, PRD_RESET_FILE));
    return archiveDir;
  });
}
