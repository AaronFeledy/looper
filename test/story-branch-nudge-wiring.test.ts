import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runIteration, StepFailureError } from "../src/lib/orchestrator.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths, readRunState, writeRunState } from "../src/lib/state-files.ts";
import { createStoryStateStore } from "../src/persistence/story-state-store.ts";
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
  runGit(repoDir, ["init", "-q", "-b", "master"]);
  writeFileSync(join(repoDir, "README.md"), "fixture\n");
  runGit(repoDir, ["add", "README.md"]);
  runGit(repoDir, ["-c", "user.name=Looper Test", "-c", "user.email=looper@example.test", "commit", "-q", "-m", "fixture"]);
  return { repoDir, configDir };
}

function makeClient(input: {
  readonly repoDir: string;
  readonly onPrompt?: () => void | Promise<void>;
  readonly failPromptAfter?: number;
}): { readonly client: OpencodeClient; readonly promptTexts: string[] } {
  const promptTexts: string[] = [];
  let created = 0;
  const client = {
    session: {
      create: async () => {
        created += 1;
        return { data: { id: created === 1 ? "ses_build" : `ses_${created}` } };
      },
      prompt: async (params: { sessionID: string; parts: { type: string; text: string }[] }) => {
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        await input.onPrompt?.();
        if (input.failPromptAfter !== undefined && promptTexts.length > input.failPromptAfter) {
          return { error: { message: "rename reminder failed" } };
        }
        writeIdleContinuationRecord(input.repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { ses_build: { type: "idle" }, ses_2: { type: "idle" } } }),
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
        if (prompts === 2) runGit(repoDir, ["branch", "-m", "us-608a-authoring-translation-contracts"]);
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

  test("fails the step without advancing when the rename reminder fails", async () => {
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

    // When the rename-reminder follow-up fails, no completion hook advances the checkpoint.
    let advanced = false;
    await expect(runIteration({
      state,
      iteration: 1,
      client: stub.client,
      repoDir,
      configDir,
      hooks: { onStepFinish: () => { advanced = true; } },
    })).rejects.toBeInstanceOf(StepFailureError);

    // Then the failed repair stays visible.
    expect(advanced).toBe(false);
    expect(stub.promptTexts).toHaveLength(2);
    expect(state.steps.map((row) => [row.name, row.status])).toEqual([["Build", "failed"]]);
  });
});


describe("verified branch repair regressions", () => {
  test.each(["unchanged", "config-edit", "main", "detached", "wrong-story"])("does not advance after a %s repair", async (repair) => {
    const { repoDir, configDir } = setupGitRepo();
    const prdDir = join(repoDir, "spec");
    mkdirSync(prdDir);
    writeFileSync(join(prdDir, "prd.json"), JSON.stringify({ userStories: [{ id: "US-609E0", passes: true }] }));
    let prompts = 0;
    const stub = makeClient({ repoDir, onPrompt: () => {
      prompts += 1;
      if (prompts === 1) runGit(repoDir, ["checkout", "-q", "-b", "feat/us-609e0-recipe-init"]);
      if (prompts !== 2) return;
      if (repair === "config-edit") writeFileSync(join(configDir, "looper.yaml"), 'storyIdPattern: "^feat/(.+)-recipe-init$"\nsteps:\n  build:\n    prompt: build.md\n');
      if (repair === "main") runGit(repoDir, ["checkout", "-q", "-b", "main"]);
      if (repair === "detached") runGit(repoDir, ["checkout", "-q", "--detach", "HEAD"]);
      if (repair === "wrong-story") runGit(repoDir, ["branch", "-m", "us-609e-recipe-init"]);
    } });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    let finished = false;
    await expect(runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, prdDir,
      hooks: {
        onStepSession: (bound) => writeRunState({ iteration: bound.iteration, stepIndex: bound.index, stepName: bound.stepName, sessionID: bound.sessionID, messageID: bound.messageID }),
        onStepFinish: () => { finished = true; },
      },
    })).rejects.toThrow("branch repair unresolved");
    expect(prompts).toBe(2);
    expect(finished).toBe(false);
    expect(state.steps[0]?.status).toBe("failed");
    expect(readRunState()).toMatchObject({ iteration: 1, stepIndex: 0, stepName: "Build", sessionID: "ses_build" });
  });

  test("does not verify a regex-only branch that is not a configured PRD story", async () => {
    // A rename to us-999-work matches the fallback pattern but is not in prd.json.
    // Treating that as repaired would let setsPhase/expects land on story.next.
    const { repoDir, configDir } = setupGitRepo();
    const prdDir = join(repoDir, "spec");
    mkdirSync(prdDir);
    writeFileSync(join(prdDir, "prd.json"), JSON.stringify({ userStories: [{ id: "US-1", title: "One" }] }));
    writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    setsPhase: implemented\n");
    let prompts = 0;
    const stub = makeClient({ repoDir, onPrompt: () => {
      prompts += 1;
      if (prompts === 1) runGit(repoDir, ["checkout", "-q", "-b", "feat/unresolved-story"]);
      if (prompts === 2) runGit(repoDir, ["branch", "-m", "us-999-work"]);
    } });
    const store = createStoryStateStore({ configDir });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    await expect(runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, prdDir, storyState: store })).rejects.toThrow("branch repair unresolved");
    expect(prompts).toBe(2);
    expect(state.steps[0]?.status).toBe("failed");
    expect(store.readPhase("US-1")).toBeUndefined();
  });

  test("does not credit story.next when the branch is only a regex story id", async () => {
    const { repoDir, configDir } = setupGitRepo();
    const prdDir = join(repoDir, "spec");
    mkdirSync(prdDir);
    writeFileSync(join(prdDir, "prd.json"), JSON.stringify({ userStories: [{ id: "US-1", title: "One" }] }));
    writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    setsPhase: implemented\n");
    let prompts = 0;
    const stub = makeClient({ repoDir, onPrompt: () => {
      prompts += 1;
      if (prompts === 1) runGit(repoDir, ["checkout", "-q", "-b", "us-999-work"]);
    } });
    const store = createStoryStateStore({ configDir });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    await expect(runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, prdDir, storyState: store })).rejects.toThrow("branch repair unresolved");
    expect(prompts).toBe(2);
    expect(store.readPhase("US-1")).toBeUndefined();
  });

  test("recognizes a PRD split ID added during Build and runs the gated Review", async () => {
    const { repoDir, configDir } = setupGitRepo();
    const prdDir = join(repoDir, "spec");
    mkdirSync(prdDir);
    writeFileSync(join(prdDir, "prd.json"), JSON.stringify({ userStories: [] }));
    writeFileSync(join(configDir, "looper.yaml"), [
      "steps:", "  build:", "    prompt: build.md", "  review:", "    prompt: build.md",
      "    gate:", "      branch: story", "      prdPasses: true", "      phase: implemented",
      `      script: test "$LOOPER_STORY_ID" = US-609E0`, "    setsPhase: reviewed", "",
    ].join("\n"));
    let prompts = 0;
    const store = createStoryStateStore({ configDir });
    const stub = makeClient({ repoDir, onPrompt: () => {
      prompts += 1;
      if (prompts !== 1) return;
      writeFileSync(join(prdDir, "prd.json"), JSON.stringify({ userStories: [{ id: "US-609E0", passes: true }] }));
      runGit(repoDir, ["checkout", "-q", "-b", "us-609e0-recipe-init-integration"]);
      store.writePhase("US-609E0", "implemented");
    } });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    expect(await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, prdDir })).toBe("complete");
    expect(stub.promptTexts).toHaveLength(2);
    expect(stub.promptTexts[0]).toContain("Exact PRD story ID");
    expect(stub.promptTexts[1]).toContain("storyId: US-609E0\n  phase: implemented");
    expect(state.steps.map((row) => [row.name, row.status])).toEqual([["Build", "done"], ["Review", "done"]]);
    expect(store.readPhase("US-609E0")).toBe("reviewed");
  });

  test("verifies a suggested rename without changing the split-story identity", async () => {
    const { repoDir, configDir } = setupGitRepo();
    const prdDir = join(repoDir, "spec");
    mkdirSync(prdDir);
    writeFileSync(join(prdDir, "prd.json"), JSON.stringify({ userStories: [{ id: "US-609E0", passes: true }] }));
    let prompts = 0;
    const stub = makeClient({ repoDir, onPrompt: () => {
      prompts += 1;
      if (prompts === 1) runGit(repoDir, ["checkout", "-q", "-b", "feat/us-609e0-recipe-init"]);
      if (prompts === 2) runGit(repoDir, ["branch", "-m", "us-609e0-recipe-init"]);
    } });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    expect(await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, prdDir })).toBe("complete");
    expect(stub.promptTexts).toHaveLength(2);
    expect(stub.promptTexts[1]).toContain("Expected story ID: US-609E0");
    expect(state.agentLines.some((line) => line.includes("branch repair verified"))).toBe(true);
  });
});


describe("branch repair recovery and time budget", () => {
  test("rechecks an unchanged invalid branch when recovering the failed session", async () => {
    const { repoDir, configDir } = setupGitRepo();
    runGit(repoDir, ["checkout", "-q", "-b", "feat/unresolved-story"]);
    const stub = makeClient({ repoDir });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    await expect(runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir,
      resume: { sessionID: "ses_build", stepName: "Build" }, recoveryNudge: true,
    })).rejects.toThrow("branch repair unresolved");
    expect(stub.promptTexts).toHaveLength(2);
    expect(stub.promptTexts[1]).toContain("Repair the current branch name");
    expect(state.steps[0]?.status).toBe("failed");
  });

  test("a repair timeout fails without starting a fresh implementation session", async () => {
    const { repoDir, configDir } = setupGitRepo();
    writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    timeout: 1s\n");
    let prompts = 0;
    const stub = makeClient({ repoDir, onPrompt: async () => {
      prompts += 1;
      if (prompts === 1) runGit(repoDir, ["checkout", "-q", "-b", "feat/unresolved-story"]);
      if (prompts === 2) await Bun.sleep(1_100);
    } });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    await expect(runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir })).rejects.toThrow("branch repair exhausted");
    expect(prompts).toBe(2);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]?.status).toBe("failed");
  });
});
