import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectBranchDiff, type BranchDiffVcsClient } from "../src/watchers/branch-diff.ts";

const staleMainClient: BranchDiffVcsClient = {
  vcs: {
    get: async () => ({ data: { branch: "main", default_branch: "main" } }),
    diff: async () => ({ data: [] }),
  },
};

describe("branch diff remote precedence", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-branch-remotes-"));
    await $`git init -q -b main`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "base.txt"), "base\n");
    await $`git add base.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m base`.cwd(repoDir).quiet();
  });

  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  test("prefers upstream among multiple remotes when origin is absent", async () => {
    await $`git switch -q -c upstream-tip`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "upstream.txt"), "upstream\n");
    await $`git add upstream.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m upstream`.cwd(repoDir).quiet();
    await $`git update-ref refs/remotes/upstream/main HEAD`.cwd(repoDir).quiet();
    await $`git switch -q main`.cwd(repoDir).quiet();
    await $`git update-ref refs/remotes/alpha/main HEAD`.cwd(repoDir).quiet();
    await $`git remote add alpha .`.cwd(repoDir).quiet();
    await $`git remote add upstream .`.cwd(repoDir).quiet();
    await $`git remote add zeta .`.cwd(repoDir).quiet();
    await $`git symbolic-ref refs/remotes/alpha/HEAD refs/remotes/alpha/main`.cwd(repoDir).quiet();
    await $`git symbolic-ref refs/remotes/upstream/HEAD refs/remotes/upstream/main`.cwd(repoDir).quiet();
    await $`git switch -q -c feature upstream/main`.cwd(repoDir).quiet();

    const result = await collectBranchDiff(staleMainClient, repoDir, "feature");

    expect(result).toEqual({ kind: "ok", totals: { additions: 0, deletions: 0, files: 0 } });
  });

  test("matches the entire slash-containing default after the exact remote prefix", async () => {
    await $`git switch -q -c release-tip`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "release.txt"), "release\n");
    await $`git add release.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m release`.cwd(repoDir).quiet();
    await $`git update-ref refs/remotes/corp/release/2026 HEAD`.cwd(repoDir).quiet();
    await $`git switch -q main`.cwd(repoDir).quiet();
    await $`git update-ref refs/remotes/origin/release/2026 HEAD`.cwd(repoDir).quiet();
    await $`git remote add corp .`.cwd(repoDir).quiet();
    await $`git symbolic-ref refs/remotes/corp/HEAD refs/remotes/corp/release/2026`.cwd(repoDir).quiet();
    await $`git switch -q -c feature corp/release/2026`.cwd(repoDir).quiet();
    const client: BranchDiffVcsClient = {
      vcs: {
        get: async () => ({ data: { branch: "main", default_branch: "release/2026" } }),
        diff: async () => ({ data: [] }),
      },
    };

    const result = await collectBranchDiff(client, repoDir, "feature");

    expect(result).toEqual({ kind: "ok", totals: { additions: 0, deletions: 0, files: 0 } });
  });

  test("treats a primary-remote-looking SDK default as a bare branch name", async () => {
    await $`git update-ref refs/heads/release/2026 HEAD`.cwd(repoDir).quiet();
    await $`git switch -q -c collision-tip`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "collision.txt"), "collision\n");
    await $`git add collision.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m collision`.cwd(repoDir).quiet();
    await $`git update-ref refs/remotes/corp/corp/release/2026 HEAD`.cwd(repoDir).quiet();
    await $`git remote add corp .`.cwd(repoDir).quiet();
    await $`git symbolic-ref refs/remotes/corp/HEAD refs/remotes/corp/corp/release/2026`.cwd(repoDir).quiet();
    await $`git switch -q -c feature corp/corp/release/2026`.cwd(repoDir).quiet();
    const client: BranchDiffVcsClient = {
      vcs: {
        get: async () => ({ data: { branch: "main", default_branch: "corp/release/2026" } }),
        diff: async () => ({ data: [] }),
      },
    };

    const result = await collectBranchDiff(client, repoDir, "feature");

    expect(result).toEqual({ kind: "ok", totals: { additions: 0, deletions: 0, files: 0 } });
  });

  test("resolves a dash-prefixed local default as a ref rather than an option", async () => {
    await $`git update-ref refs/heads/--help HEAD`.cwd(repoDir).quiet();
    await $`git switch -q -c feature`.cwd(repoDir).quiet();
    const client: BranchDiffVcsClient = {
      vcs: {
        get: async () => ({ data: { branch: "main", default_branch: "--help" } }),
        diff: async () => ({ data: [] }),
      },
    };

    const result = await collectBranchDiff(client, repoDir, "feature");

    expect(result).toEqual({ kind: "ok", totals: { additions: 0, deletions: 0, files: 0 } });
  });
});
