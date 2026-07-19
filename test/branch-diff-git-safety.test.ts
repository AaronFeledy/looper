import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectBranchDiff, type BranchDiffVcsClient } from "../src/watchers/branch-diff.ts";
import { BRANCH_DIFF_GIT_MAX_OUTPUT_BYTES } from "../src/watchers/branch-diff-git.ts";

const staleMainClient: BranchDiffVcsClient = {
  vcs: {
    get: async () => ({ data: { branch: "main", default_branch: "main" } }),
    diff: async () => ({ data: [] }),
  },
};

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("branch diff Git fallback safety", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-branch-git-safety-"));
    await $`git init -q -b main`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "base.txt"), "base\n");
    await $`git add base.txt`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m base`.cwd(repoDir).quiet();
    await $`git switch -q -c feature`.cwd(repoDir).quiet();
  });

  afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

  test("aborts a real fallback before later untracked child work continues", async () => {
    for (let index = 0; index < 200; index += 1) {
      writeFileSync(join(repoDir, `untracked-${index.toString().padStart(3, "0")}.txt`), "line\n".repeat(1_000));
    }
    const controller = new AbortController();
    const pending = collectBranchDiff(staleMainClient, repoDir, "feature", controller.signal);
    await Bun.sleep(5);

    controller.abort();

    expect(await rejectionMessage(pending)).toMatch(/cancel/i);
  });

  test("rejects an untracked set beyond the fallback file cap", async () => {
    for (let index = 0; index < 1_001; index += 1) {
      writeFileSync(join(repoDir, `untracked-${index.toString().padStart(4, "0")}.txt`), "x\n");
    }

    expect(await rejectionMessage(collectBranchDiff(staleMainClient, repoDir, "feature"))).toMatch(/too many untracked files/i);
  });

  test("disables a configured fsmonitor command for every fallback invocation", async () => {
    const marker = join(repoDir, "fsmonitor-ran");
    const probe = join(repoDir, "fsmonitor-probe.sh");
    writeFileSync(probe, `#!/bin/sh\nprintf hit >> "${marker}"\nprintf '\\n'\n`);
    chmodSync(probe, 0o755);
    await $`git config core.fsmonitor ${probe}`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "untracked.txt"), "new\n");

    await collectBranchDiff(staleMainClient, repoDir, "feature");

    expect(existsSync(marker)).toBe(false);
  });

  test("kills Git and returns a typed error when command output exceeds the cap", async () => {
    const names: string[] = [];
    const suffix = "x".repeat(64);
    const count = Math.ceil(BRANCH_DIFF_GIT_MAX_OUTPUT_BYTES / (suffix.length + 16)) * 2;
    for (let index = 0; index < count; index += 1) names.push(`remote-${index}-${suffix}`);
    appendFileSync(join(repoDir, ".git", "config"), names.map((name) => `\n[remote "${name}"]\n\turl = .\n`).join(""));

    const message = await rejectionMessage(collectBranchDiff(staleMainClient, repoDir, "feature"));

    expect(message).toMatch(/Git output exceeded/i);
  });

  test("sanitizes and caps a nested SDK error message", async () => {
    const message = `bad\n\u001b[31mred\u0000 thing ${"x".repeat(500)}`;
    const client: BranchDiffVcsClient = {
      vcs: {
        get: async () => ({ error: { data: { message } } }),
        diff: async () => ({ data: [] }),
      },
    };

    let observed = "";
    try {
      await collectBranchDiff(client, repoDir, "feature");
    } catch (error) {
      if (error instanceof Error) observed = error.message;
    }

    expect(observed).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(observed.startsWith("bad [31mred thing")).toBe(true);
    expect(observed.length).toBeLessThanOrEqual(300);
  });
});
