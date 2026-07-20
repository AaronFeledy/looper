import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { currentGitBranch, storyIdFromBranch } from "../src/lib/story-id.ts";

type StoryIdCase = {
  readonly name: string;
  readonly branch: string;
  readonly pattern?: string;
  readonly expected: string | undefined;
};

const STORY_ID_CASES: readonly StoryIdCase[] = [
  {
    name: "derives the Lando story id with the default pattern",
    branch: "us-074-provider-lando-linux-setup",
    expected: "US-074",
  },
  { name: "does not derive a story id from main", branch: "main", expected: undefined },
  { name: "does not derive a story id from an empty branch", branch: "", expected: undefined },
  { name: "does not derive a story id from a non-matching branch", branch: "feature/provider-setup", expected: undefined },
  {
    name: "uses a custom capture pattern",
    branch: "story/us-074",
    pattern: "^story/([a-z]+-[0-9]+)$",
    expected: "US-074",
  },
  {
    name: "treats an invalid custom pattern as no match",
    branch: "story/us-074",
    pattern: "[",
    expected: undefined,
  },
];

describe("storyIdFromBranch", () => {
  for (const testCase of STORY_ID_CASES) {
    test(testCase.name, () => {
      // Given a branch and an optional configured pattern.
      const { branch, pattern } = testCase;

      // When the story id is derived.
      const actual = storyIdFromBranch(branch, pattern);

      // Then only capture group one is returned, uppercased.
      expect(actual).toBe(testCase.expected);
    });
  }
});

const scratchDirs: string[] = [];

function createScratchDir(label: string): string {
  const dir = join(import.meta.dir, ".tmp", `${label}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  scratchDirs.push(dir);
  return dir;
}

function runGit(repoDir: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoDir, stdout: "ignore", stderr: "ignore" });
  expect(result.exitCode).toBe(0);
}

function createGitRepo(branch: string): string {
  const repoDir = createScratchDir("story-id-git");
  runGit(repoDir, ["init", "-q"]);
  writeFileSync(join(repoDir, "README.md"), "fixture\n");
  runGit(repoDir, ["add", "README.md"]);
  runGit(repoDir, ["-c", "user.name=Looper Test", "-c", "user.email=looper@example.test", "commit", "-q", "-m", "fixture"]);
  runGit(repoDir, ["checkout", "-q", "-b", branch]);
  return repoDir;
}

describe("currentGitBranch", () => {
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("returns the current branch from a fresh git read", async () => {
    // Given a repository checked out on a story branch.
    const repoDir = createGitRepo("us-074-provider-lando-linux-setup");

    // When the branch is read.
    const branch = await currentGitBranch(repoDir);

    // Then the checked-out branch is returned.
    expect(branch).toBe("us-074-provider-lando-linux-setup");
  });

  test("returns undefined for detached HEAD", async () => {
    // Given a repository with HEAD detached at the current commit.
    const repoDir = createGitRepo("us-074-provider-lando-linux-setup");
    runGit(repoDir, ["checkout", "-q", "--detach", "HEAD"]);

    // When the branch is read.
    const branch = await currentGitBranch(repoDir);

    // Then detached HEAD is not treated as a branch.
    expect(branch).toBeUndefined();
  });

  test("returns undefined without throwing outside a git repository", async () => {
    // Given a non-git directory under the repository test scratch area.
    const repoDir = createScratchDir("story-id-no-git");
    writeFileSync(join(repoDir, ".git"), "not a git repository\n");

    // When the branch is read.
    const branch = await currentGitBranch(repoDir);

    // Then the failed git probe is represented as undefined.
    expect(branch).toBeUndefined();
  });
});
