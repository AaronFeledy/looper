import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createStoryStateStore } from "../src/persistence/story-state-store.ts";

const MAIN_ENTRY = resolve(import.meta.dir, "../src/main.ts");

function setupCliScratch(): { readonly repoDir: string; readonly configDir: string; readonly statePath: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-story-fresh-"));
  const configDir = join(repoDir, ".looper");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "build.md"), "Stop immediately.\n");
  writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n");
  const statePath = join(configDir, ".looper-story-state.json");
  return { repoDir, configDir, statePath };
}

async function runFreshCli(repoDir: string, tty: boolean): Promise<number> {
  const env = {
    ...process.env,
    LOOPER_CONFIG_DIR: join(repoDir, ".looper"),
    LOOPER_REPO_DIR: repoDir,
    OPENCODE_BIN: "looper-test-missing-opencode",
  };
  if (!tty) {
    const child = Bun.spawn(["bun", MAIN_ENTRY, "--fresh", "--start", "1"], { cwd: repoDir, env, stdout: "ignore", stderr: "ignore" });
    return child.exited;
  }
  const command = `bun ${MAIN_ENTRY} --fresh --start 1`;
  const child = Bun.spawn(["script", "-qefc", command, "/dev/null"], { cwd: repoDir, env, stdout: "ignore", stderr: "ignore" });
  return child.exited;
}

describe("story state store", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  test("initializes paths and delegates story phase operations", () => {
    // Given a file-backed story state store.
    scratch = mkdtempSync(join(tmpdir(), "looper-story-store-"));
    const store = createStoryStateStore({ configDir: scratch });

    // When two phases are written and one is cleared through the facade.
    store.writePhase("US-074", "reviewed");
    store.writePhase("US-075", "verified");
    const first = store.readPhase("US-074");
    const second = store.readPhase("US-075");
    store.clear();

    // Then facade reads use the configured directory and clear removes the state file.
    expect(first).toBe("reviewed");
    expect(second).toBe("verified");
    expect(existsSync(join(scratch, ".looper-story-state.json"))).toBe(false);
  });

  test("--fresh clears story state on the non-TTY path before server startup", async () => {
    // Given persisted story state in a valid non-TTY CLI configuration.
    const fixture = setupCliScratch();
    scratch = fixture.repoDir;
    writeFileSync(fixture.statePath, JSON.stringify({ stories: { "US-074": { phase: "reviewed", updatedAt: "2026-07-20T00:00:00.000Z" } } }));

    // When a fresh non-TTY run reaches the deliberately failing server startup.
    const exitCode = await runFreshCli(fixture.repoDir, false);

    // Then fresh state was cleared before startup failed.
    expect(exitCode).toBe(1);
    expect(existsSync(fixture.statePath)).toBe(false);
  });

  test("--fresh clears story state on the TTY path before server startup", async () => {
    // Given persisted story state and a pseudo-terminal CLI invocation.
    const fixture = setupCliScratch();
    scratch = fixture.repoDir;
    writeFileSync(fixture.statePath, JSON.stringify({ stories: { "US-074": { phase: "reviewed", updatedAt: "2026-07-20T00:00:00.000Z" } } }));

    // When a fresh TTY run reaches the deliberately failing server startup.
    const exitCode = await runFreshCli(fixture.repoDir, true);

    // Then the TTY fresh path cleared story state first.
    expect(exitCode).toBe(1);
    expect(existsSync(fixture.statePath)).toBe(false);
  });
});
