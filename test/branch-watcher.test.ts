import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseHeadContents,
  readBranchFromHead,
  resolveGitHeadPath,
  watchBranch,
} from "../src/lib/branch-watcher.ts";

const POLL_MS = 50;

async function waitForBranch(
  observed: string[],
  predicate: (branches: string[]) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(observed)) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for branch; observed=${JSON.stringify(observed)}`);
}

describe("parseHeadContents", () => {
  test("extracts branch from ref pointer", () => {
    expect(parseHeadContents("ref: refs/heads/main\n")).toBe("main");
  });

  test("preserves slashes in nested branch names", () => {
    expect(parseHeadContents("ref: refs/heads/feature/foo/bar\n")).toBe("feature/foo/bar");
  });

  test("handles CRLF line endings", () => {
    expect(parseHeadContents("ref: refs/heads/main\r\n")).toBe("main");
  });

  test("handles missing trailing newline", () => {
    expect(parseHeadContents("ref: refs/heads/main")).toBe("main");
  });

  test("returns 'detached' for a raw OID", () => {
    expect(parseHeadContents("0123456789abcdef0123456789abcdef01234567\n")).toBe("detached");
  });

  test("returns 'detached' when the ref name is empty", () => {
    expect(parseHeadContents("ref: refs/heads/\n")).toBe("detached");
  });

  test("returns null for empty content", () => {
    expect(parseHeadContents("")).toBeNull();
    expect(parseHeadContents("\n")).toBeNull();
  });
});

describe("resolveGitHeadPath", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "looper-bw-resolve-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null when the directory is not a git repo", async () => {
    const result = await resolveGitHeadPath(dir);
    expect(result).toBeNull();
  });

  test("returns the HEAD path inside an initialized repo", async () => {
    await $`git init -q -b main`.cwd(dir).quiet();
    const result = await resolveGitHeadPath(dir);
    expect(result).not.toBeNull();
    expect(result!.endsWith("/HEAD")).toBe(true);
    // Should resolve to the real .git directory inside the repo.
    expect(readBranchFromHead(result!)).toBe("main");
  });
});

describe("watchBranch", () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "looper-bw-watch-"));
    await $`git init -q -b main`.cwd(dir).quiet();
    // Need an initial commit so `git checkout -b` and `git checkout <branch>`
    // succeed without complaining about an unborn branch.
    await $`git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`
      .cwd(dir)
      .quiet();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null on non-repo directories", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "looper-bw-nonrepo-"));
    try {
      const watcher = await watchBranch({ repoDir: nonRepo, onChange: () => {} });
      expect(watcher).toBeNull();
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  test("fires onChange with the initial branch and again on HEAD writes", async () => {
    const observed: string[] = [];
    const watcher = await watchBranch({
      repoDir: dir,
      pollIntervalMs: POLL_MS,
      onChange: (branch) => observed.push(branch),
    });
    expect(watcher).not.toBeNull();
    expect(watcher!.initial).toBe("main");
    expect(observed).toEqual(["main"]);

    try {
      const headPath = (await resolveGitHeadPath(dir))!;
      writeFileSync(headPath, "ref: refs/heads/feature\n");
      await waitForBranch(observed, (b) => b.includes("feature"));

      writeFileSync(headPath, "0123456789abcdef0123456789abcdef01234567\n");
      await waitForBranch(observed, (b) => b.includes("detached"));

      expect(observed).toEqual(["main", "feature", "detached"]);
    } finally {
      watcher!.stop();
    }
  });

  // Regression test for the original bug: Bun's fs.watch silently drops
  // HEAD-rename events emitted by `git checkout`, so the previous
  // event-driven watcher missed every branch switch. Polling sees it because
  // it reads HEAD on a timer, independent of inotify.
  test("detects a real `git checkout` branch switch", async () => {
    const observed: string[] = [];
    const watcher = await watchBranch({
      repoDir: dir,
      pollIntervalMs: POLL_MS,
      onChange: (branch) => observed.push(branch),
    });
    expect(watcher).not.toBeNull();
    expect(observed).toEqual(["main"]);

    try {
      await $`git checkout -q -b feature`.cwd(dir).quiet();
      await waitForBranch(observed, (b) => b.at(-1) === "feature");

      await $`git checkout -q main`.cwd(dir).quiet();
      await waitForBranch(observed, (b) => b.at(-1) === "main");

      expect(observed.length).toBeGreaterThanOrEqual(3);
      expect(observed.at(-1)).toBe("main");
    } finally {
      watcher!.stop();
    }
  });

  test("refresh() picks up changes immediately without waiting for the poll", async () => {
    const observed: string[] = [];
    // Use a long poll interval so any detection within the test window must
    // come from refresh(), not from the background timer firing.
    const watcher = await watchBranch({
      repoDir: dir,
      pollIntervalMs: 60_000,
      onChange: (branch) => observed.push(branch),
    });
    expect(watcher).not.toBeNull();
    expect(observed).toEqual(["main"]);

    try {
      const headPath = (await resolveGitHeadPath(dir))!;
      writeFileSync(headPath, "ref: refs/heads/feature\n");
      // No poll yet — observation should still be just ["main"].
      expect(observed).toEqual(["main"]);

      watcher!.refresh();
      expect(observed).toEqual(["main", "feature"]);

      // Calling refresh() again with no change is a no-op.
      watcher!.refresh();
      expect(observed).toEqual(["main", "feature"]);
    } finally {
      watcher!.stop();
    }
  });

  test("stop() halts both the timer and refresh()", async () => {
    const observed: string[] = [];
    const watcher = await watchBranch({
      repoDir: dir,
      pollIntervalMs: POLL_MS,
      onChange: (branch) => observed.push(branch),
    });
    expect(watcher).not.toBeNull();
    watcher!.stop();

    const headPath = (await resolveGitHeadPath(dir))!;
    const before = observed.length;
    writeFileSync(headPath, "ref: refs/heads/feature\n");
    // refresh() after stop() must be a no-op.
    watcher!.refresh();
    // And the background timer must not fire either.
    await Bun.sleep(POLL_MS * 4);
    expect(observed.length).toBe(before);
  });
});
