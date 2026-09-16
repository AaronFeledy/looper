import { statSync } from "node:fs";

import { countPrd, prdIndexPath, readPrdStories } from "../lib/prd.ts";
import type { PrdStatus } from "./watcher-events.ts";
import type { StoryPhaseResolver } from "../engine/story-phases.ts";

export const DEFAULT_PRD_POLL_INTERVAL_MS = 3_000;

export type PrdWatcher = {
  readonly refresh: () => void;
  readonly stop: () => void;
};

/** Local status shape used until Phase B injects the story-phase resolver. */
export type PrdReadResult =
  | { readonly kind: "ok"; readonly remaining: number; readonly total: number; readonly terminal?: string }
  | { readonly kind: "error"; readonly message: string };

function assertNever(value: never): never {
  throw new Error(`unhandled PRD result: ${JSON.stringify(value)}`);
}

function resultToStatus(result: PrdReadResult): PrdStatus {
  switch (result.kind) {
    case "ok":
      return { kind: "ok", remaining: result.remaining, total: result.total, ...(result.terminal !== undefined ? { terminal: result.terminal } : {}) };
    case "error":
      return { kind: "error", message: result.message };
    default:
      return assertNever(result);
  }
}

/**
 * Best-effort counts without a phase resolver: every story is treated as
 * `building` against terminal `merged`, so remaining === total. Phase B will
 * inject the resolver for effective-phase counts.
 */
export function readPrdStatus(prdDir: string): PrdReadResult {
  const indexPath = prdIndexPath(prdDir);
  const stories = readPrdStories(indexPath);
  if (stories === undefined) {
    try {
      // Distinguish missing vs unreadable-ish content for the panel.
      statSync(indexPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return { kind: "error", message: "prd.json not found" };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "error", message };
    }
    return { kind: "error", message: "unreadable prd.json" };
  }
  const counts = countPrd({ stories, phases: {}, terminal: "merged" });
  return { kind: "ok", remaining: counts.remaining, total: counts.total, terminal: "merged" };
}

export function readResolvedPrdStatus(resolver: StoryPhaseResolver): PrdReadResult {
  const snapshot = resolver.snapshot();
  if (snapshot === undefined) return { kind: "error", message: "unreadable prd.json" };
  const counts = countPrd(snapshot);
  return { kind: "ok", remaining: counts.remaining, total: counts.total, terminal: snapshot.terminal };
}

function readMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (error) {
    if (error instanceof Error) return null;
    return null;
  }
}

function sameStatus(left: PrdStatus | null, right: PrdStatus): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

export function watchPrd(opts: {
  readonly prdDir: string;
  readonly onUpdate: (status: PrdStatus) => void;
  readonly pollIntervalMs?: number;
  readonly read?: (dir: string) => PrdReadResult;
}): PrdWatcher {
  const read = opts.read ?? readPrdStatus;
  const indexPath = prdIndexPath(opts.prdDir);
  let lastMtimeMs: number | null = null;
  let lastStatus: PrdStatus | null = null;
  let stopped = false;

  const emit = (status: PrdStatus): void => {
    if (stopped || sameStatus(lastStatus, status)) return;
    lastStatus = status;
    opts.onUpdate(status);
  };

  const readAndEmit = (): void => {
    lastMtimeMs = readMtimeMs(indexPath);
    emit(resultToStatus(read(opts.prdDir)));
  };

  const poll = (): void => {
    if (stopped) return;
    const nextMtimeMs = readMtimeMs(indexPath);
    if (nextMtimeMs === null) {
      lastMtimeMs = null;
      emit(resultToStatus(read(opts.prdDir)));
      return;
    }
    if (lastMtimeMs !== null && nextMtimeMs === lastMtimeMs) return;
    lastMtimeMs = nextMtimeMs;
    emit(resultToStatus(read(opts.prdDir)));
  };

  readAndEmit();

  const timer = setInterval(poll, opts.pollIntervalMs ?? DEFAULT_PRD_POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    refresh: () => {
      if (stopped) return;
      readAndEmit();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
