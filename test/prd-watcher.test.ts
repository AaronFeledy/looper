import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchPrd } from "../src/lib/prd-watcher.ts";
import { PRD_INDEX_FILENAME } from "../src/lib/prd.ts";
import type { PrdStatus } from "../src/lib/state.ts";

const POLL_MS = 20;

async function waitForPrdStatus(
  observed: readonly PrdStatus[],
  predicate: (statuses: readonly PrdStatus[]) => boolean,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(observed)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for PRD status; observed=${JSON.stringify(observed)}`);
}

function writePrd(dir: string, passes: readonly boolean[]): void {
  const userStories = passes.map((value) => ({ passes: value }));
  writeFileSync(join(dir, PRD_INDEX_FILENAME), JSON.stringify({ userStories }));
}

describe("watchPrd", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "looper-prd-watch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("fires an initial status immediately", () => {
    // Given: a PRD file with one passing and one remaining story.
    writePrd(dir, [true, false]);
    const observed: PrdStatus[] = [];

    // When: the watcher starts.
    const watcher = watchPrd({
      prdDir: dir,
      pollIntervalMs: 60_000,
      onUpdate: (status) => observed.push(status),
    });

    try {
      // Then: the first status is pushed synchronously.
      expect(observed).toEqual([{ kind: "ok", remaining: 1, total: 2 }]);
    } finally {
      watcher.stop();
    }
  });

  test("publishes a changed count after prd.json is rewritten", async () => {
    // Given: a started watcher observing a PRD file.
    writePrd(dir, [true, false]);
    const observed: PrdStatus[] = [];
    const watcher = watchPrd({
      prdDir: dir,
      pollIntervalMs: POLL_MS,
      onUpdate: (status) => observed.push(status),
    });

    try {
      expect(observed).toEqual([{ kind: "ok", remaining: 1, total: 2 }]);

      // When: the file is rewritten with a different remaining count.
      writePrd(dir, [false, false]);

      // Then: polling sees the mtime change and publishes the new count.
      await waitForPrdStatus(observed, (statuses) => statuses.some((status) => status.kind === "ok" && status.remaining === 2));
      expect(observed).toEqual([
        { kind: "ok", remaining: 1, total: 2 },
        { kind: "ok", remaining: 2, total: 2 },
      ]);
    } finally {
      watcher.stop();
    }
  });

  test("publishes an error when prd.json disappears", async () => {
    // Given: a watcher with a readable PRD file.
    writePrd(dir, [true]);
    const observed: PrdStatus[] = [];
    const watcher = watchPrd({
      prdDir: dir,
      pollIntervalMs: POLL_MS,
      onUpdate: (status) => observed.push(status),
    });

    try {
      // When: the PRD file is deleted.
      unlinkSync(join(dir, PRD_INDEX_FILENAME));

      // Then: polling publishes a non-throwing error status.
      await waitForPrdStatus(observed, (statuses) => statuses.some((status) => status.kind === "error"));
      const last = observed.at(-1);
      if (last?.kind !== "error") throw new Error(`expected final error status, got ${JSON.stringify(last)}`);
      expect(last.message).toContain("prd.json not found");
    } finally {
      watcher.stop();
    }
  });

  test("refresh() re-reads immediately and suppresses identical statuses", () => {
    // Given: a long-poll watcher so only refresh() can observe within the test.
    writePrd(dir, [true, false]);
    const observed: PrdStatus[] = [];
    const watcher = watchPrd({
      prdDir: dir,
      pollIntervalMs: 60_000,
      onUpdate: (status) => observed.push(status),
    });

    try {
      // When: refresh() runs without a file change.
      watcher.refresh();

      // Then: the identical status is not emitted again.
      expect(observed).toEqual([{ kind: "ok", remaining: 1, total: 2 }]);

      // When: the file changes and refresh() is called.
      writePrd(dir, [true, true]);
      watcher.refresh();

      // Then: the changed status is emitted immediately.
      expect(observed).toEqual([
        { kind: "ok", remaining: 1, total: 2 },
        { kind: "ok", remaining: 0, total: 2 },
      ]);
    } finally {
      watcher.stop();
    }
  });

  test("stop() prevents timer and refresh callbacks", async () => {
    // Given: a running watcher.
    writePrd(dir, [false]);
    const observed: PrdStatus[] = [];
    const watcher = watchPrd({
      prdDir: dir,
      pollIntervalMs: POLL_MS,
      onUpdate: (status) => observed.push(status),
    });
    expect(observed).toEqual([{ kind: "ok", remaining: 1, total: 1 }]);

    // When: the watcher stops and the file changes.
    watcher.stop();
    writePrd(dir, [true]);
    watcher.refresh();
    await Bun.sleep(POLL_MS * 4);

    // Then: no further updates are published.
    expect(observed).toEqual([{ kind: "ok", remaining: 1, total: 1 }]);
  });
});
