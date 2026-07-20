import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { runEngine } from "../src/engine/run-engine.ts";
import { runIteration, StepFailureError } from "../src/lib/orchestrator.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths, readRunState } from "../src/lib/state-files.ts";
import { createRunStateStore } from "../src/persistence/run-state-store.ts";
import { createStoryStateStore } from "../src/persistence/story-state-store.ts";
import { createInMemoryAdjudicationStore } from "./helpers/adjudication-stub.ts";

type Scratch = { readonly repoDir: string; readonly configDir: string; readonly prdDir: string };

const scratchDirs: string[] = [];

async function setup(setsPhase?: string): Promise<Scratch> {
  const repoDir = join(import.meta.dir, ".tmp", `story-phase-${crypto.randomUUID()}`);
  const configDir = join(repoDir, ".looper");
  const prdDir = join(repoDir, "spec");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(join(configDir, "build.md"), "build the story\n");
  writeFileSync(
    join(configDir, "looper.yaml"),
    ["prd: ../../spec", "steps:", "  build:", "    prompt: build.md", ...(setsPhase === undefined ? [] : [`    setsPhase: ${setsPhase}`])].join("\n") + "\n",
  );
  writePrd(prdDir, true);
  await $`git init -q -b us-074-story-state`.cwd(repoDir).quiet();
  await $`git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.cwd(repoDir).quiet();
  initStatePaths({ configDir });
  scratchDirs.push(repoDir);
  return { repoDir, configDir, prdDir };
}

function writePrd(prdDir: string, passes: boolean): void {
  writeFileSync(join(prdDir, "prd.json"), JSON.stringify({ userStories: [{ id: "US-074", passes }] }));
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function clientFor(repoDir: string, onPrompt?: (prompt: string) => void): { readonly client: OpencodeClient; readonly prompts: string[] } {
  const prompts: string[] = [];
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_build" } }),
      prompt: async (params: { sessionID: string; parts: { text: string }[] }) => {
        const prompt = params.parts.map((part) => part.text).join("\n");
        prompts.push(prompt);
        onPrompt?.(prompt);
        const dir = join(repoDir, ".omo", "run-continuation");
        mkdirSync(dir, { recursive: true });
        const at = new Date().toISOString();
        writeFileSync(join(dir, `${params.sessionID}.json`), JSON.stringify({ sessionID: params.sessionID, updatedAt: at, sources: { "background-task": { state: "idle", updatedAt: at } } }));
        return { data: {} };
      },
      status: async () => ({ data: { ses_build: { type: "idle" } } }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> { await waitForAbort(options.signal); })(),
      }),
    },
  } as unknown as OpencodeClient;
  return { client, prompts };
}

function adjudication() {
  return { store: createInMemoryAdjudicationStore(), threshold: 99, writeStop: () => {} };
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runIteration story phase wiring", () => {
  test("writes setsPhase before onStepFinish", async () => {
    // Given a successful step that declares a lifecycle phase.
    const scratch = await setup("reviewed");
    const phasesAtFinish: Array<string | undefined> = [];
    const store = createStoryStateStore({ configDir: scratch.configDir });

    // When the step completes.
    await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }), iteration: 1, client: clientFor(scratch.repoDir).client, ...scratch,
      hooks: { onStepFinish: () => phasesAtFinish.push(store.readPhase("US-074")) } });

    // Then the write is durable before the completion hook can advance the pointer.
    expect(phasesAtFinish).toEqual(["reviewed"]);
    expect(store.readPhase("US-074")).toBe("reviewed");
  });

  test("blocks setsPhase on a true-to-false flip", async () => {
    // Given a reviewed story and a step that would advance it while changing passes to false.
    const scratch = await setup("published");
    const store = createStoryStateStore({ configDir: scratch.configDir });
    store.writePhase("US-074", "reviewed");

    // When the step flips the PRD snapshot.
    await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }), iteration: 1,
      client: clientFor(scratch.repoDir, () => writePrd(scratch.prdDir, false)).client, ...scratch, adjudication: adjudication() });

    // Then the requested phase is blocked and the independent demotion wins.
    expect(store.readPhase("US-074")).toBe("building");
  });

  test("does not regress a published story through setsPhase", async () => {
    // Given a published story and a later step declaring an earlier phase.
    const scratch = await setup("implemented");
    const store = createStoryStateStore({ configDir: scratch.configDir });
    store.writePhase("US-074", "published");

    // When the step completes without a PRD flip.
    await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }), iteration: 1, client: clientFor(scratch.repoDir).client, ...scratch });

    // Then monotonic lifecycle state is preserved.
    expect(store.readPhase("US-074")).toBe("published");
  });

  test("auto-demotes on a true-to-false flip without setsPhase", async () => {
    // Given a verified story and a step with no setsPhase declaration.
    const scratch = await setup();
    const store = createStoryStateStore({ configDir: scratch.configDir });
    store.writePhase("US-074", "verified");
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });

    // When the step flips passes from true to false.
    await runIteration({ state, iteration: 1, client: clientFor(scratch.repoDir, () => writePrd(scratch.prdDir, false)).client, ...scratch, adjudication: adjudication() });

    // Then the phase moves backward only through auto-demotion and emits one line.
    expect(store.readPhase("US-074")).toBe("building");
    expect(state.agentLines.filter((line) => line.includes("auto-demoted US-074"))).toHaveLength(1);
  });

  test("injects real story facts into the prompt", async () => {
    // Given a story branch, passing PRD story, and persisted phase.
    const scratch = await setup();
    createStoryStateStore({ configDir: scratch.configDir }).writePhase("US-074", "reviewed");
    const stub = clientFor(scratch.repoDir);

    // When the prompt is composed with story context enabled.
    await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }), iteration: 1, client: stub.client, ...scratch });

    // Then the rendered block carries the values collected at the engine boundary.
    expect(stub.prompts[0]).toContain("story:\n  branch: us-074-story-state\n  storyId: US-074\n  passes: true\n  phase: reviewed");
  });

  test("story-state write failure leaves the durable pointer on the step", async () => {
    // Given a phase-writing step whose state target cannot be atomically replaced.
    const scratch = await setup("reviewed");
    const store = createRunStateStore({ configDir: scratch.configDir });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });

    // When the engine reaches phase persistence.
    const error = await (async (): Promise<unknown> => {
      try {
        await runEngine({ fresh: false, maxIterations: 1, waitProvided: false, waitDuration: 0, ...scratch,
          client: clientFor(scratch.repoDir, () => mkdirSync(join(scratch.configDir, ".looper-story-state.json"))).client, store,
          loadSteps: () => [{ name: "Build", prompt: join(scratch.configDir, "build.md"), setsPhase: "reviewed" }],
          currentBranch: async () => "us-074-story-state", createLooperRunID: () => "run-phase-failure", legacyResumeStepIndex: () => 0,
          hooks: { createIterationState: () => state }, runIteration });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    // Then the typed failure is surfaced before the resume pointer advances.
    expect(error).toBeInstanceOf(StepFailureError);
    expect(readRunState()?.stepName).toBe("Build");
    expect(JSON.parse(readFileSync(join(scratch.configDir, ".looper-run.json"), "utf8"))["stepIndex"]).toBe(0);
    expect(state.steps[0]?.status).toBe("failed");
    expect(state.agentLines.some((line) => line.includes("[looper] story phase write failed for US-074:"))).toBe(true);
    expect(state.steps[0]?.outputLines.some((line) => line.includes("[looper] story phase write failed for US-074:"))).toBe(true);
  });
});
