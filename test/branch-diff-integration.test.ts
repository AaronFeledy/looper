import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectBranchDiff, type BranchDiffVcsClient, type BranchDiffVcsInfo } from "../src/watchers/branch-diff.ts";
import { watchBranchDiff } from "../src/watchers/branch-diff-watcher.ts";
import type { BranchDiffStatus } from "../src/watchers/watcher-events.ts";

const LONG_POLL = 60_000;

async function waitForStatus(statuses: readonly BranchDiffStatus[], kind: BranchDiffStatus["kind"]): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (statuses.some((status) => status.kind === kind)) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${kind} branch diff status`);
}

describe("branch diff watcher integration", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-branch-diff-integration-"));
    await $`git init -q -b main`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "tracked.txt"), "base\n");
    await $`git add tracked.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m init`.cwd(repoDir).quiet();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("converges feature to main while the SDK branch remains stale on feature", async () => {
    await $`git switch -q -c feature`.cwd(repoDir).quiet();
    let branch = "feature";
    const sdkInfo: BranchDiffVcsInfo = { branch: "feature", default_branch: "main" };
    const client: BranchDiffVcsClient = {
      vcs: {
        get: async () => ({ data: sdkInfo }),
        diff: async () => ({ data: [{ additions: 8, deletions: 0 }] }),
      },
    };
    const statuses: BranchDiffStatus[] = [];
    const watcher = watchBranchDiff({
      getBranch: () => branch,
      pollIntervalMs: LONG_POLL,
      collect: (capturedBranch) => collectBranchDiff(client, repoDir, capturedBranch),
      onUpdate: (status) => statuses.push(status),
    });
    try {
      await waitForStatus(statuses, "ok");

      await $`git switch -q main`.cwd(repoDir).quiet();
      branch = "main";
      watcher.refresh();

      await waitForStatus(statuses, "hidden");
      expect(statuses.at(-1)).toEqual({ kind: "hidden" });
    } finally {
      watcher.stop();
    }
  });

  test("converges main to feature through Git while the SDK branch remains stale on main", async () => {
    await $`git switch -q -c feature`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "tracked.txt"), "feature\n");
    await $`git add tracked.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m feature`.cwd(repoDir).quiet();
    await $`git switch -q main`.cwd(repoDir).quiet();
    let branch = "main";
    const sdkInfo: BranchDiffVcsInfo = { branch: "main", default_branch: "main" };
    const client: BranchDiffVcsClient = {
      vcs: {
        get: async () => ({ data: sdkInfo }),
        diff: async () => ({ data: [] }),
      },
    };
    const statuses: BranchDiffStatus[] = [];
    const watcher = watchBranchDiff({
      getBranch: () => branch,
      pollIntervalMs: LONG_POLL,
      collect: (capturedBranch) => collectBranchDiff(client, repoDir, capturedBranch),
      onUpdate: (status) => statuses.push(status),
    });
    try {
      await waitForStatus(statuses, "hidden");

      await $`git switch -q feature`.cwd(repoDir).quiet();
      writeFileSync(join(repoDir, "untracked.txt"), "working\n");
      branch = "feature";
      watcher.refresh();

      await waitForStatus(statuses, "ok");
      expect(statuses.at(-1)).toEqual({ kind: "ok", additions: 2, deletions: 1, files: 2 });
    } finally {
      watcher.stop();
    }
  });
});
