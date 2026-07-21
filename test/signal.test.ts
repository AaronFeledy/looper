import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

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

describe("looper signal", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  test.each([
    ["adjudicate", ".looper-adjudicate", "requirements conflict", "requirements conflict"],
    ["stop", ".looper-stop", "operator request", "operator request\n"],
    ["stop-after-iteration", ".looper-stop-after-iteration", "maintenance", "maintenance\n"],
  ] as const)("writes the %s marker from a cold shell", async (kind, fileName, reason, expectedContent) => {
    // Given an empty state directory with no running Looper process.
    const fixture = createScratch();
    scratch = fixture.repoDir;

    // When the signal command is invoked directly.
    const result = await runCli(fixture.repoDir, ["signal", kind, "--reason", reason, "--config-dir", fixture.configDir]);

    // Then it succeeds and writes the existing transport's exact raw format.
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(readFileSync(join(fixture.configDir, fileName), "utf8")).toBe(expectedContent);
  });

  test("writes an explicit story phase as parsed JSON", async () => {
    // Given an empty state directory with no config or server.
    const fixture = createScratch();
    scratch = fixture.repoDir;

    // When a story phase signal names the story explicitly.
    const result = await runCli(fixture.repoDir, [
      "signal",
      "story-phase",
      "merged",
      "--story",
      "US-999",
      "--config-dir",
      fixture.configDir,
    ]);

    // Then the story state file contains the requested phase.
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const state = JSON.parse(readFileSync(join(fixture.configDir, ".looper-story-state.json"), "utf8"));
    expect(state).toMatchObject({ stories: { "US-999": { phase: "merged", updatedAt: expect.any(String) } } });
  });

  test("derives the story from the current branch with the configured pattern", async () => {
    // Given a git branch and a custom story-id pattern in the resolved config directory.
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

    // When story-phase omits --story.
    const result = await runCli(fixture.repoDir, ["signal", "story-phase", "verified", "--config-dir", fixture.configDir]);

    // Then the branch-derived uppercase story id is persisted.
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const state = JSON.parse(readFileSync(join(fixture.configDir, ".looper-story-state.json"), "utf8"));
    expect(state).toMatchObject({ stories: { "US-321": { phase: "verified" } } });
  });

  test("returns exit 2 when the story cannot be derived", async () => {
    // Given a non-git repo and no explicit story id.
    const fixture = createScratch();
    scratch = fixture.repoDir;

    // When story-phase is invoked without --story.
    const result = await runCli(fixture.repoDir, ["signal", "story-phase", "merged", "--config-dir", fixture.configDir]);

    // Then usage fails closed without writing story state.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--story");
    expect(existsSync(join(fixture.configDir, ".looper-story-state.json"))).toBe(false);
  });

  test("returns exit 2 with usage for an unknown signal", async () => {
    // Given a cold shell with no configuration.
    const fixture = createScratch();
    scratch = fixture.repoDir;

    // When an unknown signal kind is invoked.
    const result = await runCli(fixture.repoDir, ["signal", "bogus", "--config-dir", fixture.configDir]);

    // Then the CLI reports a usage error and creates no signal files.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown signal 'bogus'");
    expect(result.stderr).toContain("Usage: looper");
  });
});
