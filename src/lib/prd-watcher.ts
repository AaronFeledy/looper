import { statSync } from "node:fs";

import { prdIndexPath, readPrd } from "./prd.ts";
import type { PrdResult } from "./prd.ts";
import type { PrdStatus } from "./state.ts";

export const DEFAULT_PRD_POLL_INTERVAL_MS = 3_000;

export type PrdWatcher = {
  readonly refresh: () => void;
  readonly stop: () => void;
};

function assertNever(value: never): never {
  throw new Error(`unhandled PRD result: ${JSON.stringify(value)}`);
}

function resultToStatus(result: PrdResult): PrdStatus {
  switch (result.kind) {
    case "ok":
      return { kind: "ok", remaining: result.remaining, total: result.total };
    case "error":
      return { kind: "error", message: result.message };
    default:
      return assertNever(result);
  }
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
  readonly read?: (dir: string) => PrdResult;
}): PrdWatcher {
  const read = opts.read ?? readPrd;
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
