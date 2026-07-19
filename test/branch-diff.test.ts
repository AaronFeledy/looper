import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aggregateBranchDiff, collectBranchDiff, type BranchDiffVcsClient, type BranchDiffVcsInfo, type BranchDiffVcsResult } from "../src/watchers/branch-diff.ts";

type VcsDiffFile = { file: string; additions: number; deletions: number; status?: "added" | "deleted" | "modified" };
type VcsGetResult = BranchDiffVcsResult<BranchDiffVcsInfo>;
type VcsDiffResult = BranchDiffVcsResult<readonly VcsDiffFile[]>;

function makeVcsClient(opts: {
  get: VcsGetResult | (() => VcsGetResult | Promise<VcsGetResult>);
  diff?: VcsDiffResult | (() => VcsDiffResult | Promise<VcsDiffResult>);
  onGet?: (params: { directory?: string }) => void;
  onDiff?: (params: { directory?: string; mode: "branch"; context?: number }) => void;
  onGetOptions?: (options: { readonly signal?: AbortSignal } | undefined) => void;
  onDiffOptions?: (options: { readonly signal?: AbortSignal } | undefined) => void;
}): BranchDiffVcsClient {
  return {
    vcs: {
      get: async (params: { directory?: string }, options?: { readonly signal?: AbortSignal }) => {
        opts.onGet?.(params);
        opts.onGetOptions?.(options);
        return typeof opts.get === "function" ? await opts.get() : opts.get;
      },
      diff: async (params: { directory?: string; mode: "branch"; context?: number }, options?: { readonly signal?: AbortSignal }) => {
        opts.onDiff?.(params);
        opts.onDiffOptions?.(options);
        const diff = opts.diff ?? { data: [] };
        return typeof diff === "function" ? await diff() : diff;
      },
    },
  };
}

describe("aggregateBranchDiff", () => {
  test("sums additions/deletions and counts files", () => {
    expect(
      aggregateBranchDiff([
        { additions: 3, deletions: 1 },
        { additions: 10, deletions: 0 },
      ]),
    ).toEqual({ additions: 13, deletions: 1, files: 2 });
  });

  test("returns zeroes for no changes", () => {
    expect(aggregateBranchDiff([])).toEqual({ additions: 0, deletions: 0, files: 0 });
  });
});

describe("collectBranchDiff", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-branch-diff-"));
    await $`git init -q -b main`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "tracked.txt"), "base\n");
    await $`git add tracked.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m init`.cwd(repoDir).quiet();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("hides when the current branch equals the detected default branch and never diffs", async () => {
    let diffCalls = 0;
    const client = makeVcsClient({
      get: { data: { branch: "main", default_branch: "main" } },
      onDiff: () => {
        diffCalls += 1;
      },
    });
    expect(await collectBranchDiff(client, "/repo", "main")).toEqual({ kind: "hidden" });
    expect(diffCalls).toBe(0);
  });

  test("aggregates the branch diff for a feature branch", async () => {
    const client = makeVcsClient({
      get: { data: { branch: "feature", default_branch: "main" } },
      diff: {
        data: [
          { file: "a.ts", additions: 12, deletions: 3, status: "modified" },
          { file: "b.ts", additions: 4, deletions: 0, status: "added" },
        ],
      },
    });
    expect(await collectBranchDiff(client, "/repo", "feature")).toEqual({ kind: "ok", totals: { additions: 16, deletions: 3, files: 2 } });
  });

  test("hides immediately on stale SDK feature branch when the authoritative branch switched to main", async () => {
    let diffCalls = 0;
    const client = makeVcsClient({
      get: { data: { branch: "feature", default_branch: "main" } },
      onDiff: () => {
        diffCalls += 1;
      },
    });

    const result = await collectBranchDiff(client, repoDir, "main");

    expect(result).toEqual({ kind: "hidden" });
    expect(diffCalls).toBe(0);
  });

  test("falls back to one net Git diff on stale SDK main branch when the authoritative branch switched to feature", async () => {
    await $`git switch -q -c feature`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "tracked.txt"), "feature commit\n");
    await $`git add tracked.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m feature`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "tracked.txt"), "working tree\n");
    writeFileSync(join(repoDir, "untracked.txt"), "new\nfile\n");
    writeFileSync(join(repoDir, "binary.bin"), new Uint8Array([0, 1, 2]));
    const client = makeVcsClient({
      get: { data: { branch: "main", default_branch: "main" } },
      diff: { data: [] },
    });

    const result = await collectBranchDiff(client, repoDir, "feature");

    expect(result).toEqual({ kind: "ok", totals: { additions: 3, deletions: 1, files: 3 } });
  });

  test("uses the detected default branch origin equivalent for the Git fallback", async () => {
    await $`git update-ref refs/remotes/origin/trunk HEAD`.cwd(repoDir).quiet();
    await $`git switch -q -c feature`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "tracked.txt"), "feature\n");
    const client = makeVcsClient({
      get: { data: { branch: "main", default_branch: "trunk" } },
      diff: { data: [] },
    });

    const result = await collectBranchDiff(client, repoDir, "feature");

    expect(result).toEqual({ kind: "ok", totals: { additions: 1, deletions: 1, files: 1 } });
  });

  test("prefers origin default over a behind local default so upstream-only changes are excluded", async () => {
    await $`git switch -q -c remote-tip`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "upstream.txt"), "upstream\n");
    await $`git add upstream.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m upstream`.cwd(repoDir).quiet();
    await $`git update-ref refs/remotes/origin/main HEAD`.cwd(repoDir).quiet();
    await $`git switch -q main`.cwd(repoDir).quiet();
    await $`git switch -q -c feature origin/main`.cwd(repoDir).quiet();
    const client = makeVcsClient({
      get: { data: { branch: "main", default_branch: "main" } },
      diff: { data: [] },
    });

    const result = await collectBranchDiff(client, repoDir, "feature");

    expect(result).toEqual({ kind: "ok", totals: { additions: 0, deletions: 0, files: 0 } });
  });

  test("skips a primary remote HEAD whose branch differs from the SDK default", async () => {
    await $`git switch -q -c remote-main`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "main-only.txt"), "main\n");
    await $`git add main-only.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m remote-main`.cwd(repoDir).quiet();
    await $`git update-ref refs/remotes/origin/main HEAD`.cwd(repoDir).quiet();
    await $`git switch -q main`.cwd(repoDir).quiet();
    await $`git switch -q -c remote-master`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "master-only.txt"), "master\n");
    await $`git add master-only.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m remote-master`.cwd(repoDir).quiet();
    await $`git update-ref refs/remotes/origin/master HEAD`.cwd(repoDir).quiet();
    await $`git remote add origin .`.cwd(repoDir).quiet();
    await $`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master`.cwd(repoDir).quiet();
    await $`git switch -q -c feature origin/main`.cwd(repoDir).quiet();
    const client = makeVcsClient({
      get: { data: { branch: "main", default_branch: "main" } },
      diff: { data: [] },
    });

    const result = await collectBranchDiff(client, repoDir, "feature");

    expect(result).toEqual({ kind: "ok", totals: { additions: 0, deletions: 0, files: 0 } });
  });

  test("limits fallback tracked and untracked changes to the launch subdirectory", async () => {
    mkdirSync(join(repoDir, "inside"));
    mkdirSync(join(repoDir, "outside"));
    writeFileSync(join(repoDir, "inside", "tracked.txt"), "inside base\n");
    writeFileSync(join(repoDir, "outside", "tracked.txt"), "outside base\n");
    await $`git add inside/tracked.txt outside/tracked.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m scoped-base`.cwd(repoDir).quiet();
    await $`git switch -q -c feature`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "inside", "tracked.txt"), "inside changed\n");
    writeFileSync(join(repoDir, "outside", "tracked.txt"), "outside changed\n");
    writeFileSync(join(repoDir, "inside", "untracked.txt"), "inside new\n");
    writeFileSync(join(repoDir, "outside", "untracked.txt"), "outside new\n");
    const client = makeVcsClient({
      get: { data: { branch: "main", default_branch: "main" } },
      diff: { data: [] },
    });

    const result = await collectBranchDiff(client, join(repoDir, "inside"), "feature");

    expect(result).toEqual({ kind: "ok", totals: { additions: 2, deletions: 1, files: 2 } });
  });

  test("reports zero totals for a feature branch with no changes", async () => {
    const client = makeVcsClient({
      get: { data: { branch: "feature", default_branch: "main" } },
      diff: { data: [] },
    });
    expect(await collectBranchDiff(client, "/repo", "feature")).toEqual({ kind: "ok", totals: { additions: 0, deletions: 0, files: 0 } });
  });

  test("shows the diff (not hidden) when the default branch is unknown", async () => {
    const client = makeVcsClient({
      get: { data: { branch: "feature" } },
      diff: { data: [{ file: "a.ts", additions: 1, deletions: 1, status: "modified" }] },
    });
    expect(await collectBranchDiff(client, "/repo", "feature")).toEqual({ kind: "ok", totals: { additions: 1, deletions: 1, files: 1 } });
  });

  test("passes the directory to vcs.get and branch/context params to vcs.diff", async () => {
    const getDirs: (string | undefined)[] = [];
    const diffParams: { directory?: string; mode: string; context?: number }[] = [];
    const client = makeVcsClient({
      get: { data: { branch: "feature", default_branch: "main" } },
      diff: { data: [] },
      onGet: (params) => getDirs.push(params.directory),
      onDiff: (params) => diffParams.push(params),
    });
    await collectBranchDiff(client, "/work/repo", "feature");
    expect(getDirs).toEqual(["/work/repo"]);
    expect(diffParams).toEqual([{ directory: "/work/repo", mode: "branch", context: 0 }]);
  });

  test("passes the collection AbortSignal to both SDK requests", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const controller = new AbortController();
    const client = makeVcsClient({
      get: { data: { branch: "feature", default_branch: "main" } },
      diff: { data: [] },
      onGetOptions: (options) => signals.push(options?.signal),
      onDiffOptions: (options) => signals.push(options?.signal),
    });

    await collectBranchDiff(client, "/repo", "feature", controller.signal);

    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  test("throws when vcs.get returns an error", async () => {
    const client = makeVcsClient({ get: { error: { message: "not a git repository" } } });
    await expect(collectBranchDiff(client, "/repo", "feature")).rejects.toThrow(/not a git repository/);
  });

  test("extracts a nested SDK error data message", async () => {
    const client = makeVcsClient({ get: { error: { data: { message: "nested SDK failure" } } } });
    await expect(collectBranchDiff(client, "/repo", "feature")).rejects.toThrow(/^nested SDK failure$/);
  });

  test("throws when vcs.diff returns an error", async () => {
    const client = makeVcsClient({
      get: { data: { branch: "feature", default_branch: "main" } },
      diff: { error: { message: "diff exploded" } },
    });
    await expect(collectBranchDiff(client, "/repo", "feature")).rejects.toThrow(/diff exploded/);
  });

  test("propagates a thrown transport failure from vcs.get", async () => {
    const client = makeVcsClient({
      get: () => {
        throw new Error("connection refused");
      },
    });
    await expect(collectBranchDiff(client, "/repo", "feature")).rejects.toThrow(/connection refused/);
  });
});
