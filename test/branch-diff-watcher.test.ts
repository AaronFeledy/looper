import { describe, expect, test } from "bun:test";

import { watchBranchDiff } from "../src/watchers/branch-diff-watcher.ts";
import type { BranchDiffCollection } from "../src/watchers/branch-diff.ts";
import type { BranchDiffStatus } from "../src/watchers/watcher-events.ts";

const LONG_POLL = 60_000;

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for branch-diff status");
}

describe("watchBranchDiff", () => {
  test("maps a hidden collection to a hidden status", async () => {
    const observed: BranchDiffStatus[] = [];
    const watcher = watchBranchDiff({
      getBranch: () => "main",
      pollIntervalMs: LONG_POLL,
      collect: async () => ({ kind: "hidden" }),
      onUpdate: (status) => observed.push(status),
    });
    try {
      await waitFor(() => observed.length >= 1);
      expect(observed.at(-1)).toEqual({ kind: "hidden" });
    } finally {
      watcher.stop();
    }
  });

  test("emits ok totals for a feature branch", async () => {
    const observed: BranchDiffStatus[] = [];
    const watcher = watchBranchDiff({
      getBranch: () => "feature",
      pollIntervalMs: LONG_POLL,
      collect: async () => ({ kind: "ok", totals: { additions: 12, deletions: 3, files: 4 } }),
      onUpdate: (status) => observed.push(status),
    });
    try {
      await waitFor(() => observed.length >= 1);
      expect(observed.at(-1)).toEqual({ kind: "ok", additions: 12, deletions: 3, files: 4 });
    } finally {
      watcher.stop();
    }
  });

  test("emits zeroed ok totals for a feature branch with no changes", async () => {
    const observed: BranchDiffStatus[] = [];
    const watcher = watchBranchDiff({
      getBranch: () => "feature",
      pollIntervalMs: LONG_POLL,
      collect: async () => ({ kind: "ok", totals: { additions: 0, deletions: 0, files: 0 } }),
      onUpdate: (status) => observed.push(status),
    });
    try {
      await waitFor(() => observed.length >= 1);
      expect(observed.at(-1)).toEqual({ kind: "ok", additions: 0, deletions: 0, files: 0 });
    } finally {
      watcher.stop();
    }
  });

  test("surfaces a collection error", async () => {
    const observed: BranchDiffStatus[] = [];
    const watcher = watchBranchDiff({
      getBranch: () => "feature",
      pollIntervalMs: LONG_POLL,
      collect: async () => {
        throw new Error("vcs exploded");
      },
      onUpdate: (status) => observed.push(status),
    });
    try {
      await waitFor(() => observed.length >= 1);
      expect(observed.at(-1)).toEqual({ kind: "error", message: "vcs exploded" });
    } finally {
      watcher.stop();
    }
  });

  test("sanitizes and caps a thrown collection error at publication", async () => {
    const observed: BranchDiffStatus[] = [];
    const watcher = watchBranchDiff({
      getBranch: () => "feature",
      pollIntervalMs: LONG_POLL,
      collect: async () => {
        throw new Error(`bad\n\u001b[31mboom\u0000 ${"x".repeat(500)}`);
      },
      onUpdate: (status) => observed.push(status),
    });
    try {
      await waitFor(() => observed.some((status) => status.kind === "error"));
      const status = observed.at(-1);
      expect(status?.kind).toBe("error");
      if (status?.kind === "error") {
        expect(status.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
        expect(status.message.startsWith("bad [31mboom")).toBe(true);
        expect(status.message.length).toBeLessThanOrEqual(300);
      }
    } finally {
      watcher.stop();
    }
  });

  test("drops a stale result when the branch changed mid-collection", async () => {
    const observed: BranchDiffStatus[] = [];
    let branch = "feature-a";
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const watcher = watchBranchDiff({
      getBranch: () => branch,
      pollIntervalMs: LONG_POLL,
      collect: async (): Promise<BranchDiffCollection> => {
        call += 1;
        if (call === 1) {
          await gate;
          return { kind: "ok", totals: { additions: 1, deletions: 0, files: 1 } };
        }
        return { kind: "ok", totals: { additions: 99, deletions: 0, files: 9 } };
      },
      onUpdate: (status) => observed.push(status),
    });
    try {
      branch = "feature-b";
      release?.();
      await waitFor(() => observed.some((s) => s.kind === "ok" && s.files === 9));
      expect(observed).not.toContainEqual({ kind: "ok", additions: 1, deletions: 0, files: 1 });
      expect(observed.at(-1)).toEqual({ kind: "ok", additions: 99, deletions: 0, files: 9 });
    } finally {
      watcher.stop();
    }
  });

  test("drops an A result after A to B to A refreshes and publishes only the newest revision", async () => {
    const observed: BranchDiffStatus[] = [];
    let branch = "feature-a";
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const watcher = watchBranchDiff({
      getBranch: () => branch,
      pollIntervalMs: LONG_POLL,
      collect: async (capturedBranch): Promise<BranchDiffCollection> => {
        call += 1;
        if (call === 1) {
          await firstGate;
          return { kind: "ok", totals: { additions: 1, deletions: 0, files: 1 } };
        }
        expect(capturedBranch).toBe("feature-a");
        return { kind: "ok", totals: { additions: 3, deletions: 0, files: 3 } };
      },
      onUpdate: (status) => observed.push(status),
    });
    try {
      branch = "feature-b";
      watcher.refresh();
      branch = "feature-a";
      watcher.refresh();
      releaseFirst?.();
      await waitFor(() => observed.some((status) => status.kind === "ok" && status.files === 3));
      expect(observed).not.toContainEqual({ kind: "ok", additions: 1, deletions: 0, files: 1 });
    } finally {
      watcher.stop();
    }
  });

  test("emits loading immediately when a refresh observes a switched branch", async () => {
    const observed: BranchDiffStatus[] = [];
    let branch = "feature-a";
    let releaseSecond: (() => void) | undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let call = 0;
    const watcher = watchBranchDiff({
      getBranch: () => branch,
      pollIntervalMs: LONG_POLL,
      collect: async () => {
        call += 1;
        if (call === 1) return { kind: "ok", totals: { additions: 1, deletions: 0, files: 1 } };
        await secondGate;
        return { kind: "ok", totals: { additions: 2, deletions: 0, files: 2 } };
      },
      onUpdate: (status) => observed.push(status),
    });
    try {
      await waitFor(() => observed.some((status) => status.kind === "ok"));
      branch = "feature-b";
      watcher.refresh();
      await waitFor(() => observed.at(-1)?.kind === "loading");
      expect(observed.at(-1)).toEqual({ kind: "loading" });
    } finally {
      releaseSecond?.();
      watcher.stop();
    }
  });

  test("stop() prevents further updates", async () => {
    const observed: BranchDiffStatus[] = [];
    const watcher = watchBranchDiff({
      getBranch: () => "feature",
      pollIntervalMs: LONG_POLL,
      collect: async () => ({ kind: "ok", totals: { additions: 1, deletions: 0, files: 1 } }),
      onUpdate: (status) => observed.push(status),
    });
    await waitFor(() => observed.length >= 1);
    watcher.stop();
    const count = observed.length;
    watcher.refresh();
    await Bun.sleep(50);
    expect(observed.length).toBe(count);
  });

});
