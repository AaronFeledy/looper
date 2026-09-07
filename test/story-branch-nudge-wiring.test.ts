import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runIteration } from "../src/lib/orchestrator.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { DEFAULT_STORY_ID_PATTERN } from "../src/lib/story-id.ts";

const scratchDirs: string[] = [];
const graceKeys = ["LOOPER_EMPTY_ASSISTANT_GRACE_MS", "LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS", "LOOPER_CONTINUATION_EXIT_GRACE_MS"] as const;
const savedGrace = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of graceKeys) savedGrace.set(key, process.env[key]);
  process.env.LOOPER_EMPTY_ASSISTANT_GRACE_MS = "0";
  process.env.LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS = "1";
  process.env.LOOPER_CONTINUATION_EXIT_GRACE_MS = "1";
});

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of graceKeys) {
    const value = savedGrace.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function writeIdleContinuationRecord(repoDir: string, sessionID: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${sessionID}.json`),
    JSON.stringify({ sessionID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
  );
}

function runGit(repoDir: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoDir, stdout: "ignore", stderr: "ignore" });
  expect(result.exitCode).toBe(0);
}

function setupGitRepo(): { readonly repoDir: string; readonly configDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-story-branch-nudge-"));
  scratchDirs.push(repoDir);
  const configDir = join(repoDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  writeFileSync(join(configDir, "build.md"), "build prompt body\n");
  writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    timeout: 1h\n");
  runGit(repoDir, ["init", "-q"]);
  writeFileSync(join(repoDir, "README.md"), "fixture\n");
  runGit(repoDir, ["add", "README.md"]);
  runGit(repoDir, ["-c", "user.name=Looper Test", "-c", "user.email=looper@example.test", "commit", "-q", "-m", "fixture"]);
  return { repoDir, configDir };
}

function makeClient(input: {
  readonly repoDir: string;
  readonly onPrompt?: () => void;
  readonly failPromptAfter?: number;
}): { readonly client: OpencodeClient; readonly promptTexts: string[] } {
  const promptTexts: string[] = [];
  let created = false;
  const client = {
    session: {
      create: async () => {
        if (created) throw new Error("unexpected extra session.create");
        created = true;
        return { data: { id: "ses_build" } };
      },
      prompt: async (params: { sessionID: string; parts: { type: string; text: string }[] }) => {
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        input.onPrompt?.();
        if (input.failPromptAfter !== undefined && promptTexts.length > input.failPromptAfter) {
          return { error: { message: "rename reminder failed" } };
        }
        writeIdleContinuationRecord(input.repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { ses_build: { type: "idle" } } }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> {
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) return resolve();
            options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
      }),
    },
  } as unknown as OpencodeClient;
  return { client, promptTexts };
}

describe("runIteration story-branch mismatch follow-up", () => {
  test("sends a continue-working follow-up when a step switches onto a non-story branch", async () => {
    // Given a git repo on a default branch and a build step that creates a non-story feature branch.
    const { repoDir, configDir } = setupGitRepo();
    let prompts = 0;
    const stub = makeClient({
      repoDir,
      onPrompt: () => {
        prompts += 1;
        if (prompts === 1) runGit(repoDir, ["checkout", "-q", "-b", "feat/authoring-translation-contracts"]);
      },
    });

    // When that step completes.
    const result = await runIteration({
      state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }),
      iteration: 1,
      client: stub.client,
      repoDir,
      configDir,
    });

    // Then a same-session follow-up names the switched branch and the story-id pattern.
    expect(result).toBe("complete");
    expect(stub.promptTexts).toHaveLength(2);
    expect(stub.promptTexts[1]).toContain("'feat/authoring-translation-contracts'");
    expect(stub.promptTexts[1]).toContain(DEFAULT_STORY_ID_PATTERN);
  });

  test("does not follow up when the switched branch already matches the story-id pattern", async () => {
    // Given a git repo whose build step creates a well-named story branch.
    const { repoDir, configDir } = setupGitRepo();
    const stub = makeClient({
      repoDir,
      onPrompt: () => {
        runGit(repoDir, ["checkout", "-q", "-b", "us-608a-authoring-translation-contracts"]);
      },
    });

    // When that step completes.
    const result = await runIteration({
      state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }),
      iteration: 1,
      client: stub.client,
      repoDir,
      configDir,
    });

    // Then the original prompt is the only turn.
    expect(result).toBe("complete");
    expect(stub.promptTexts).toHaveLength(1);
  });

  test("keeps the finished step when the rename reminder fails", async () => {
    // Given a successful build that switched onto a non-story branch.
    const { repoDir, configDir } = setupGitRepo();
    let prompts = 0;
    const stub = makeClient({
      repoDir,
      failPromptAfter: 1,
      onPrompt: () => {
        prompts += 1;
        if (prompts === 1) runGit(repoDir, ["checkout", "-q", "-b", "feat/authoring-translation-contracts"]);
      },
    });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });

    // When the rename-reminder follow-up fails.
    const result = await runIteration({
      state,
      iteration: 1,
      client: stub.client,
      repoDir,
      configDir,
    });

    // Then the iteration still completes and the successful step stays done.
    expect(result).toBe("complete");
    expect(stub.promptTexts).toHaveLength(2);
    expect(state.steps.map((row) => [row.name, row.status])).toEqual([["Build", "done"]]);
  });
});
