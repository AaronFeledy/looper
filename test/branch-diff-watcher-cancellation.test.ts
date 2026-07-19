import { describe, expect, test } from "bun:test";

import { watchBranchDiff } from "../src/watchers/branch-diff-watcher.ts";
import type { BranchDiffCollection } from "../src/watchers/branch-diff.ts";
import type { BranchDiffStatus } from "../src/watchers/watcher-events.ts";

const LONG_POLL = 60_000;

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for branch-diff status");
}

describe("watchBranchDiff cancellation", () => {
  test("times out and aborts a hanging collection without wedging a later refresh", async () => {
    const observed: BranchDiffStatus[] = [];
    let call = 0;
    let firstSignal: AbortSignal | undefined;
    const watcher = watchBranchDiff({
      getBranch: () => "feature",
      pollIntervalMs: LONG_POLL,
      collectionTimeoutMs: 10,
      collect: async (_branch, signal) => {
        call += 1;
        if (call === 1) {
          firstSignal = signal;
          return await new Promise<BranchDiffCollection>(() => undefined);
        }
        return { kind: "ok", totals: { additions: 4, deletions: 0, files: 1 } };
      },
      onUpdate: (status) => observed.push(status),
    });
    try {
      await waitFor(() => observed.some((status) => status.kind === "error"));
      expect(firstSignal?.aborted).toBe(true);

      watcher.refresh();

      await waitFor(() => observed.some((status) => status.kind === "ok"));
      expect(observed.at(-1)).toEqual({ kind: "ok", additions: 4, deletions: 0, files: 1 });
    } finally {
      watcher.stop();
    }
  });

  test("stop aborts an in-flight collection without publishing a status", async () => {
    const observed: BranchDiffStatus[] = [];
    let started: (() => void) | undefined;
    const collectionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const watcher = watchBranchDiff({
      getBranch: () => "feature",
      pollIntervalMs: LONG_POLL,
      collectionTimeoutMs: LONG_POLL,
      collect: async (_branch, activeSignal) => {
        signal = activeSignal;
        started?.();
        return await new Promise<BranchDiffCollection>(() => undefined);
      },
      onUpdate: (status) => observed.push(status),
    });

    await collectionStarted;
    watcher.stop();

    expect(signal?.aborted).toBe(true);
    expect(observed).toEqual([]);
  });

  test("a superseding refresh aborts the stale collection and recovers immediately", async () => {
    const observed: BranchDiffStatus[] = [];
    let started: (() => void) | undefined;
    const collectionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let staleSignal: AbortSignal | undefined;
    let call = 0;
    const watcher = watchBranchDiff({
      getBranch: () => "feature",
      pollIntervalMs: LONG_POLL,
      collectionTimeoutMs: LONG_POLL,
      collect: async (_branch, signal) => {
        call += 1;
        if (call === 1) {
          staleSignal = signal;
          started?.();
          return await new Promise<BranchDiffCollection>(() => undefined);
        }
        return { kind: "ok", totals: { additions: 7, deletions: 1, files: 2 } };
      },
      onUpdate: (status) => observed.push(status),
    });
    try {
      await collectionStarted;

      watcher.refresh();

      await waitFor(() => observed.some((status) => status.kind === "ok"));
      expect(staleSignal?.aborted).toBe(true);
      expect(observed.at(-1)).toEqual({ kind: "ok", additions: 7, deletions: 1, files: 2 });
    } finally {
      watcher.stop();
    }
  });
});
