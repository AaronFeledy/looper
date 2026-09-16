import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { SIGNAL_LOG_FILE_NAME, readSignalsSince } from "../src/lib/signal-log.ts";

const MAIN_ENTRY = resolve(import.meta.dir, "../src/main.ts");
const SCRATCH_ROOT = join(import.meta.dir, ".tmp");

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function createScratch(): { readonly repoDir: string; readonly configDir: string } {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const repoDir = mkdtempSync(join(SCRATCH_ROOT, "signal-"));
  const configDir = join(repoDir, ".looper");
  mkdirSync(configDir);
  return { repoDir, configDir };
}

async function runCli(repoDir: string, args: readonly string[]): Promise<CliResult> {
  const child = Bun.spawn(["bun", MAIN_ENTRY, ...args], {
    cwd: repoDir,
    env: { ...process.env, LOOPER_REPO_DIR: repoDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
  return { exitCode, stdout, stderr };
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Looper Test",
  GIT_AUTHOR_EMAIL: "looper@example.test",
  GIT_COMMITTER_NAME: "Looper Test",
  GIT_COMMITTER_EMAIL: "looper@example.test",
};

async function git(repoDir: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: repoDir,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, child.stderr.text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

/** Bare origin + local repo with main tracking origin/main. */
async function initRepoWithOrigin(repoDir: string): Promise<{ readonly originDir: string }> {
  const originDir = `${repoDir}-origin`;
  mkdirSync(originDir);
  await git(originDir, ["init", "-q", "-b", "main", "--bare"]);

  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["config", "user.name", "Looper Test"]);
  await git(repoDir, ["config", "user.email", "looper@example.test"]);
  writeFileSync(join(repoDir, "README.md"), "origin\n");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-q", "-m", "initial"]);
  await git(repoDir, ["remote", "add", "origin", originDir]);
  await git(repoDir, ["push", "-q", "-u", "origin", "main"]);
  return { originDir };
}

function writeMinimalConfig(configDir: string, extra = ""): void {
  writeFileSync(join(configDir, "build.md"), "Stop immediately.\n");
  writeFileSync(
    join(configDir, "looper.yaml"),
    `${extra}steps:\n  build:\n    prompt: build.md\n`,
  );
}

function readSignalLog(configDir: string): unknown[] {
  const path = join(configDir, SIGNAL_LOG_FILE_NAME);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe("looper signal", () => {
  let scratch: string | undefined;
  let extraScratch: string | undefined;

  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    if (extraScratch !== undefined) rmSync(extraScratch, { recursive: true, force: true });
    scratch = undefined;
    extraScratch = undefined;
  });

  test.each([
    ["stop", ".looper-stop", "operator request", "operator request\n"],
    ["stop-after-iteration", ".looper-stop-after-iteration", "maintenance", "maintenance\n"],
  ] as const)("writes the %s marker from a cold shell", async (kind, fileName, reason, expectedContent) => {
    const fixture = createScratch();
    scratch = fixture.repoDir;

    const result = await runCli(fixture.repoDir, ["signal", kind, "--reason", reason, "--config-dir", fixture.configDir]);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(readFileSync(join(fixture.configDir, fileName), "utf8")).toBe(expectedContent);
    const log = readSignalLog(fixture.configDir);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind, reason });
  });

  test("writes an identified adjudication request from a cold shell", async () => {
    // Given an empty state directory with no running Looper process.
    const fixture = createScratch();
    scratch = fixture.repoDir;
    // When a cold shell requests adjudication.
    const result = await runCli(fixture.repoDir, ["signal", "adjudicate", "--reason", "requirements conflict", "--config-dir", fixture.configDir]);
    // Then the durable payload carries its reason and a unique request ID.
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const request: unknown = JSON.parse(readFileSync(join(fixture.configDir, ".looper-adjudicate"), "utf8"));
    expect(request).toMatchObject({ reason: "requirements conflict", id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  test("writes an explicit story phase as parsed JSON", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;

    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "merged",
      "--story",
      "US-999",
      "--config-dir",
      fixture.configDir,
    ]);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const state = JSON.parse(readFileSync(join(fixture.configDir, ".looper-story-state.json"), "utf8"));
    expect(state).toMatchObject({ stories: { "US-999": { phase: "merged", updatedAt: expect.any(String) } } });
    expect(readSignalLog(fixture.configDir)[0]).toMatchObject({
      kind: "story-phase",
      storyId: "US-999",
      phase: "merged",
    });
  });

  test("records optional reason on story-phase", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;

    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "building",
      "--story",
      "US-1",
      "--reason",
      "hand back defect",
      "--config-dir",
      fixture.configDir,
    ]);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(readSignalLog(fixture.configDir)[0]).toMatchObject({
      kind: "story-phase",
      phase: "building",
      reason: "hand back defect",
      storyId: "US-1",
    });
  });

  test("derives the story from the current branch with the configured pattern", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    writeFileSync(join(fixture.configDir, "build.md"), "Stop immediately.\n");
    writeFileSync(
      join(fixture.configDir, "looper.yaml"),
      'storyIdPattern: "^work/([a-z]+-[0-9]+)$"\nsteps:\n  build:\n    prompt: build.md\n',
    );
    await Bun.$`git init -q`.cwd(fixture.repoDir);
    writeFileSync(join(fixture.repoDir, "README.md"), "fixture\n");
    await Bun.$`git add README.md`.cwd(fixture.repoDir);
    await Bun.$`git -c user.name=${"Looper Test"} -c user.email=${"looper@example.test"} commit -q -m fixture`.cwd(fixture.repoDir);
    await Bun.$`git checkout -q -b work/us-321`.cwd(fixture.repoDir);

    const result = await runCli(fixture.repoDir, ["signal", "story-phase", "verified", "--config-dir", fixture.configDir]);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const state = JSON.parse(readFileSync(join(fixture.configDir, ".looper-story-state.json"), "utf8"));
    expect(state).toMatchObject({ stories: { "US-321": { phase: "verified" } } });
  });

  test("derives a split-story ID from the PRD without editing storyIdPattern", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    mkdirSync(join(fixture.repoDir, "spec"));
    writeFileSync(join(fixture.repoDir, "spec", "prd.json"), JSON.stringify({ userStories: [{ id: "US-609E0", passes: true }] }));
    writeFileSync(join(fixture.configDir, "build.md"), "Build.\n");
    writeFileSync(join(fixture.configDir, "looper.yaml"), "prd: spec\nsteps:\n  build:\n    prompt: build.md\n");
    await Bun.$`git init -q -b us-609e0-recipe-init-integration`.cwd(fixture.repoDir);
    await Bun.$`git -c user.name=test -c user.email=test@example.test commit -q --allow-empty -m fixture`.cwd(fixture.repoDir);
    const result = await runCli(fixture.repoDir, ["signal", "story-phase", "implemented", "--config-dir", fixture.configDir]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const state = JSON.parse(readFileSync(join(fixture.configDir, ".looper-story-state.json"), "utf8"));
    expect(state).toMatchObject({ stories: { "US-609E0": { phase: "implemented" } } });
  });

  test("returns exit 2 when the story cannot be derived", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;

    const result = await runCli(fixture.repoDir, ["signal", "story-phase", "merged", "--config-dir", fixture.configDir]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--story");
    expect(existsSync(join(fixture.configDir, ".looper-story-state.json"))).toBe(false);
  });

  test("returns exit 2 with usage for an unknown signal", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;

    const result = await runCli(fixture.repoDir, ["signal", "bogus", "--config-dir", fixture.configDir]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown signal 'bogus'");
    expect(result.stderr).toContain("Usage: looper");
  });

  test("blocked and no-op require reason and log optionally storyless", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;

    const blocked = await runCli(fixture.repoDir, [
      "signal",
      "blocked",
      "--reason",
      "permission gate timed out",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(blocked).toMatchObject({ exitCode: 0, stderr: "" });
    expect(blocked.stdout).toContain("Blocked recorded");

    const noop = await runCli(fixture.repoDir, [
      "signal",
      "no-op",
      "--reason",
      "already done",
      "--story",
      "US-42",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(noop).toMatchObject({ exitCode: 0, stderr: "" });

    const log = readSignalLog(fixture.configDir);
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "blocked", reason: "permission gate timed out" }),
        expect.objectContaining({ kind: "no-op", reason: "already done", storyId: "US-42" }),
      ]),
    );
    // blocked has no storyId when storyless
    expect((log[0] as { storyId?: string }).storyId).toBeUndefined();
  });

  test("blocked without --reason exits 2", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    const result = await runCli(fixture.repoDir, ["signal", "blocked", "--config-dir", fixture.configDir]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--reason");
  });

  test("implemented rejects when origin/main exists and only PRD paths changed", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    writeMinimalConfig(fixture.configDir, "prd: spec\n");
    mkdirSync(join(fixture.repoDir, "spec"));
    writeFileSync(join(fixture.repoDir, "spec", "prd.json"), JSON.stringify({ userStories: [{ id: "US-100" }] }));

    const { originDir } = await initRepoWithOrigin(fixture.repoDir);
    extraScratch = originDir;

    await git(fixture.repoDir, ["checkout", "-q", "-b", "us-100-feature"]);
    // PRD-only change — not material
    writeFileSync(join(fixture.repoDir, "spec", "progress.txt"), "churn\n");
    await git(fixture.repoDir, ["add", "spec/progress.txt"]);
    await git(fixture.repoDir, ["commit", "-q", "-m", "prd only"]);

    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "implemented",
      "--story",
      "US-100",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot claim implemented");
    expect(result.stderr).toContain("outside the PRD");
    expect(existsSync(join(fixture.configDir, ".looper-story-state.json"))).toBe(false);
  });

  test("implemented accepts material commits ahead of origin/main", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    writeMinimalConfig(fixture.configDir, "prd: spec\n");
    mkdirSync(join(fixture.repoDir, "spec"));
    writeFileSync(join(fixture.repoDir, "spec", "prd.json"), JSON.stringify({ userStories: [{ id: "US-100" }] }));

    const { originDir } = await initRepoWithOrigin(fixture.repoDir);
    extraScratch = originDir;

    await git(fixture.repoDir, ["checkout", "-q", "-b", "us-100-feature"]);
    writeFileSync(join(fixture.repoDir, "src.ts"), "export const x = 1;\n");
    await git(fixture.repoDir, ["add", "src.ts"]);
    await git(fixture.repoDir, ["commit", "-q", "-m", "material"]);

    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "implemented",
      "--story",
      "US-100",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const state = JSON.parse(readFileSync(join(fixture.configDir, ".looper-story-state.json"), "utf8"));
    expect(state).toMatchObject({ stories: { "US-100": { phase: "implemented" } } });
  });

  test("published rejects without a remote story branch", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    writeMinimalConfig(fixture.configDir);

    const { originDir } = await initRepoWithOrigin(fixture.repoDir);
    extraScratch = originDir;

    await git(fixture.repoDir, ["checkout", "-q", "-b", "us-200-local-only"]);
    writeFileSync(join(fixture.repoDir, "a.ts"), "1\n");
    await git(fixture.repoDir, ["add", "a.ts"]);
    await git(fixture.repoDir, ["commit", "-q", "-m", "local"]);

    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "published",
      "--story",
      "US-200",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("push the branch first");
  });

  test("published accepts when origin has the story branch", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    writeMinimalConfig(fixture.configDir);

    const { originDir } = await initRepoWithOrigin(fixture.repoDir);
    extraScratch = originDir;

    await git(fixture.repoDir, ["checkout", "-q", "-b", "us-200-feature"]);
    writeFileSync(join(fixture.repoDir, "a.ts"), "1\n");
    await git(fixture.repoDir, ["add", "a.ts"]);
    await git(fixture.repoDir, ["commit", "-q", "-m", "work"]);
    await git(fixture.repoDir, ["push", "-q", "-u", "origin", "us-200-feature"]);

    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "published",
      "--story",
      "US-200",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  });

  test("merged rejects when story branch is not an ancestor of origin/main", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    writeMinimalConfig(fixture.configDir);

    const { originDir } = await initRepoWithOrigin(fixture.repoDir);
    extraScratch = originDir;

    await git(fixture.repoDir, ["checkout", "-q", "-b", "us-300-feature"]);
    writeFileSync(join(fixture.repoDir, "a.ts"), "1\n");
    await git(fixture.repoDir, ["add", "a.ts"]);
    await git(fixture.repoDir, ["commit", "-q", "-m", "unmerged"]);
    await git(fixture.repoDir, ["push", "-q", "-u", "origin", "us-300-feature"]);

    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "merged",
      "--story",
      "US-300",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot claim merged");
  });

  test("merged accepts when story tip is ancestor of origin/main", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    writeMinimalConfig(fixture.configDir);

    const { originDir } = await initRepoWithOrigin(fixture.repoDir);
    extraScratch = originDir;

    // Feature branch, then merge into main and push so origin/main contains the tip.
    await git(fixture.repoDir, ["checkout", "-q", "-b", "us-300-feature"]);
    writeFileSync(join(fixture.repoDir, "a.ts"), "1\n");
    await git(fixture.repoDir, ["add", "a.ts"]);
    await git(fixture.repoDir, ["commit", "-q", "-m", "feature"]);
    await git(fixture.repoDir, ["push", "-q", "-u", "origin", "us-300-feature"]);

    await git(fixture.repoDir, ["checkout", "-q", "main"]);
    await git(fixture.repoDir, ["merge", "-q", "--no-ff", "-m", "merge feature", "us-300-feature"]);
    await git(fixture.repoDir, ["push", "-q", "origin", "main"]);
    await git(fixture.repoDir, ["checkout", "-q", "us-300-feature"]);
    await git(fixture.repoDir, ["fetch", "-q", "origin"]);

    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "merged",
      "--story",
      "US-300",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  });

  test("merged accepts when no story branch exists (cannot disprove)", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;

    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "merged",
      "--story",
      "US-404",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  });

  test("story-phase refuses to regress below a derived published phase", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    writeMinimalConfig(fixture.configDir);

    const { originDir } = await initRepoWithOrigin(fixture.repoDir);
    extraScratch = originDir;

    await git(fixture.repoDir, ["checkout", "-q", "-b", "us-500-feature"]);
    writeFileSync(join(fixture.repoDir, "a.ts"), "1\n");
    await git(fixture.repoDir, ["add", "a.ts"]);
    await git(fixture.repoDir, ["commit", "-q", "-m", "work"]);
    await git(fixture.repoDir, ["push", "-q", "-u", "origin", "us-500-feature"]);

    // Derived phase is published; demoting to building must fail
    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "building",
      "--story",
      "US-500",
      "--reason",
      "should not demote past derived",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("derived phase");
    expect(result.stderr).toContain("published");
    expect(existsSync(join(fixture.configDir, ".looper-story-state.json"))).toBe(false);
  });


  test("implemented accepts material commit even when net tree diff is empty", async () => {
    // A commit adds then a later commit deletes the same file: net diff empty, but
    // a material commit still landed on HEAD ahead of origin/main.
    const fixture = createScratch();
    scratch = fixture.repoDir;
    writeMinimalConfig(fixture.configDir, "prd: spec\n");
    mkdirSync(join(fixture.repoDir, "spec"));
    writeFileSync(join(fixture.repoDir, "spec", "prd.json"), JSON.stringify({ userStories: [{ id: "US-100" }] }));

    const { originDir } = await initRepoWithOrigin(fixture.repoDir);
    extraScratch = originDir;

    await git(fixture.repoDir, ["checkout", "-q", "-b", "us-100-feature"]);
    writeFileSync(join(fixture.repoDir, "src.ts"), "export const x = 1;\n");
    await git(fixture.repoDir, ["add", "src.ts"]);
    await git(fixture.repoDir, ["commit", "-q", "-m", "add material"]);
    await git(fixture.repoDir, ["rm", "-q", "src.ts"]);
    await git(fixture.repoDir, ["commit", "-q", "-m", "remove material"]);

    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "implemented",
      "--story",
      "US-100",
      "--config-dir",
      fixture.configDir,
    ]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  });

  test("merged honors LOOPER_STORY_FETCH_TIMEOUT_MS=0 (skips fetch, still checks ancestry)", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    writeMinimalConfig(fixture.configDir);

    const { originDir } = await initRepoWithOrigin(fixture.repoDir);
    extraScratch = originDir;

    await git(fixture.repoDir, ["checkout", "-q", "-b", "us-300-feature"]);
    writeFileSync(join(fixture.repoDir, "a.ts"), "1\n");
    await git(fixture.repoDir, ["add", "a.ts"]);
    await git(fixture.repoDir, ["commit", "-q", "-m", "unmerged"]);
    await git(fixture.repoDir, ["push", "-q", "-u", "origin", "us-300-feature"]);

    const child = Bun.spawn(["bun", MAIN_ENTRY, "signal", "story-phase", "merged", "--story", "US-300", "--config-dir", fixture.configDir], {
      cwd: fixture.repoDir,
      env: { ...process.env, LOOPER_REPO_DIR: fixture.repoDir, LOOPER_STORY_FETCH_TIMEOUT_MS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, child.stderr.text()]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("cannot claim merged");
  });

  test("readSignalsSince sees CLI-written records", async () => {
    const fixture = createScratch();
    scratch = fixture.repoDir;
    const before = Date.now() - 1000;
    await runCli(fixture.repoDir, ["signal", "stop", "--reason", "later", "--config-dir", fixture.configDir]);
    const records = readSignalsSince(fixture.configDir, before);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("stop");
  });
});
