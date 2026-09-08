import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { runIteration } from "../src/lib/orchestrator.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { DEFAULT_STORY_ID_PATTERN } from "../src/lib/story-id.ts";
import * as budgets from "../src/engine/run-control.ts";
import * as runners from "../src/lib/runner.ts";
import { TitleCoordinator } from "../src/engine/title-coordinator.ts";
import * as brokerOwners from "../src/opencode/request-broker-owner.ts";

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
  readonly onPrompt?: (signal: AbortSignal) => void | Promise<void>;
  readonly onTitle?: (title: string) => void;
  readonly failPromptAfter?: number;
}): { readonly client: OpencodeClient; readonly promptTexts: string[] } {
  const promptTexts: string[] = [];
  let parentID = "";
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_build" } }),
      prompt: async (params: { sessionID: string; messageID: string; parts: { type: string; text: string }[] }, options: { signal: AbortSignal }) => {
        parentID = params.messageID;
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        await input.onPrompt?.(options.signal);
        if (input.failPromptAfter !== undefined && promptTexts.length > input.failPromptAfter) {
          return { error: { message: "rename reminder failed" } };
        }
        writeIdleContinuationRecord(input.repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { ses_build: { type: "idle" } } }),
      messages: async () => ({ data: [{ info: { id: "asst_done", role: "assistant", parentID, time: { created: 1, completed: 2 }, tokens: { output: 1 } }, parts: [{ id: "part_done", messageID: "asst_done", sessionID: "ses_build", type: "text", text: "done" }] }] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
      update: async ({ title }: { title: string }) => { input.onTitle?.(title); return { data: {} }; },
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
  test("disposes title coordination and the broker when prompt reading throws", async () => {
    // Given a branch-title step whose prompt disappears after config loading.
    const { repoDir, configDir } = setupGitRepo();
    writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    title: branch\n");
    const cancel = spyOn(TitleCoordinator.prototype, "cancel");
    const createOwner = brokerOwners.createRequestBrokerOwner;
    let disposed = false;
    const ownerSpy = spyOn(brokerOwners, "createRequestBrokerOwner").mockImplementation((input) => {
      const owner = createOwner(input);
      return { ...owner, dispose: () => { disposed = true; owner.dispose(); } };
    });
    try {
      // When the per-step lifecycle unwinds before prompt dispatch.
      await expect(runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }), iteration: 1, client: makeClient({ repoDir }).client, repoDir, configDir,
        hooks: { onStepBegin: () => rmSync(join(configDir, "build.md")) } })).rejects.toThrow("missing prompt file");
      // Then both resource owners are released on the exceptional path.
      expect(cancel).toHaveBeenCalled();
      expect(disposed).toBe(true);
    } finally { cancel.mockRestore(); ownerSpy.mockRestore(); }
  });

  test("does not inherit the provisional title of a skipped step", async () => {
    // Given an eager branch title and an existing inherited description.
    const { repoDir, configDir } = setupGitRepo();
    writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    title: branch\n  review:\n    prompt: build.md\n");
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    state.branch = "main";
    let titled: () => void = () => {};
    const titleApplied = new Promise<void>((resolve) => { titled = resolve; });
    let prompts = 0;
    const stub = makeClient({ repoDir, onTitle: () => titled(), onPrompt: async (signal) => {
      if (++prompts === 1) {
        state.branch = "us-075-provisional";
        await titleApplied;
        state.control.setSkipRequested(true);
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } });
    // When the titled step is skipped and the next step completes.
    await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, initialWorkDescription: "original" });
    // Then both rows discard the skipped candidate and Review inherits the original.
    expect(state.steps.map((row) => row.title)).toEqual([undefined, "original"]);
  });

  test("keeps the concrete iteration step list stable across a config edit", async () => {
    // Given two configured steps.
    const { repoDir, configDir } = setupGitRepo();
    writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n  review:\n    prompt: build.md\n");
    const names: string[] = [];
    // When the first step inserts a new preceding step into the config.
    await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] }), iteration: 1, client: makeClient({ repoDir }).client, repoDir, configDir,
      hooks: { onStepFinish: ({ step }) => {
        names.push(step.name);
        if (names.length === 1) writeFileSync(join(configDir, "looper.yaml"), "steps:\n  inserted:\n    prompt: build.md\n  build:\n    prompt: build.md\n  review:\n    prompt: build.md\n");
      } } });
    // Then this iteration still runs each original logical step once.
    expect(names).toEqual(["Build", "Review"]);
  });
  test("gives the reminder a fresh budget and clears its timeout restart request", async () => {
    // Given a completed step whose entire original budget has elapsed.
    const { repoDir, configDir } = setupGitRepo();
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const budget = spyOn(budgets, "remainingStepBudgetMs").mockReturnValue(3_600_000);
    const runStep = runners.runOpenCodeStep;
    const timeouts: Array<number | undefined> = [];
    const runSpy = spyOn(runners, "runOpenCodeStep").mockImplementation((input) => {
      timeouts.push(input.timeoutMsOverride);
      return runStep(input);
    });
    let prompts = 0;
    const stub = makeClient({ repoDir, onPrompt: () => {
      prompts += 1;
      if (prompts === 1) {
        runGit(repoDir, ["checkout", "-q", "-b", "feat/rename"]);
        budget.mockReturnValue(0);
      } else state.control.requestRestart("timeout");
    } });
    try {
      // When the advisory reminder requests a timeout restart.
      await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });
      // Then it was dispatched despite zero remaining budget and cannot poison the next step.
      expect(prompts).toBe(2);
      expect(timeouts).toEqual([3_600_000, 30_000]);
      expect([state.control.restartRequested, state.control.restartReason]).toEqual([false, undefined]);
      expect(state.steps[0]?.status).toBe("done");
    } finally { budget.mockRestore(); runSpy.mockRestore(); }
  });

  test("does not replace the completed turn checkpoint with the reminder turn", async () => {
    // Given a step which needs an advisory rename.
    const { repoDir, configDir } = setupGitRepo();
    let prompts = 0;
    const outcomes: string[] = [];
    const stub = makeClient({ repoDir, onPrompt: () => {
      if (++prompts === 1) runGit(repoDir, ["checkout", "-q", "-b", "feat/rename"]);
    } });
    // When both turns complete.
    await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }), iteration: 1, client: stub.client, repoDir, configDir,
      hooks: { onStepSession: (info) => { outcomes.push(info.messageID); } } });
    // Then advisory dispatch never changes the classified outcome identity.
    expect(new Set(outcomes).size).toBe(1);
    expect(prompts).toBe(2);
  });
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
