import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadSteps } from "../src/lib/config.ts";
import { runIteration, StepFailureError } from "../src/lib/orchestrator.ts";
import { appendSignal } from "../src/lib/signal-log.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createAdjudicationStore } from "../src/persistence/adjudication-store.ts";
import { createStoryStateStore } from "../src/persistence/story-state-store.ts";

type Scratch = { readonly repoDir: string; readonly configDir: string; readonly prdDir: string };

const scratchDirs: string[] = [];
const originalGateMaxMs = process.env.LOOPER_PERMISSION_GATE_MAX_MS;
// Multi-turn wiring waits on real grace windows; shrink them like the sibling wiring tests do.
const graceKeys = ["LOOPER_EMPTY_ASSISTANT_GRACE_MS", "LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS", "LOOPER_CONTINUATION_EXIT_GRACE_MS"] as const;
const savedGrace = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of graceKeys) savedGrace.set(key, process.env[key]);
  process.env.LOOPER_EMPTY_ASSISTANT_GRACE_MS = "0";
  process.env.LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS = "1";
  process.env.LOOPER_CONTINUATION_EXIT_GRACE_MS = "1";
});

function setup(expects = "reviewed"): Scratch {
  const repoDir = join(import.meta.dir, ".tmp", `step-outcome-${crypto.randomUUID()}`);
  const configDir = join(repoDir, ".looper");
  const prdDir = join(repoDir, "spec");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(join(configDir, "step.md"), "perform the checklist\n");
  writeFileSync(join(configDir, "looper.yaml"), `steps:\n  verify:\n    prompt: step.md\n    expects: ${expects}\n`);
  writeFileSync(join(prdDir, "prd.json"), JSON.stringify({ userStories: [{ id: "US-1", title: "Story", dependsOn: [] }] }));
  Bun.spawnSync(["git", "init", "-q", "-b", "us-1-work"], { cwd: repoDir });
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repoDir });
  initStatePaths({ configDir });
  scratchDirs.push(repoDir);
  return { repoDir, configDir, prdDir };
}

function permissionAsked(): Event {
  return {
    type: "permission.asked",
    properties: { id: "per_timeout", sessionID: "ses_verify", permission: "external_directory", patterns: ["/tmp"] },
  } as unknown as Event;
}

function clientFor(
  repoDir: string,
  onPrompt: (prompt: string, call: number) => void,
  event?: Event,
): { readonly client: OpencodeClient; readonly prompts: string[] } {
  const prompts: string[] = [];
  let messageID = "";
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_verify" } }),
      prompt: async (params: { sessionID: string; messageID: string; parts: { text: string }[] }) => {
        messageID = params.messageID;
        const prompt = params.parts.map((part) => part.text).join("\n");
        prompts.push(prompt);
        onPrompt(prompt, prompts.length);
        const continuationDir = join(repoDir, ".omo", "run-continuation");
        mkdirSync(continuationDir, { recursive: true });
        const at = new Date().toISOString();
        writeFileSync(join(continuationDir, `${params.sessionID}.json`), JSON.stringify({ sessionID: params.sessionID, updatedAt: at, sources: { "background-task": { state: "idle", updatedAt: at } } }));
        if (event !== undefined) await Bun.sleep(20);
        return { data: {} };
      },
      status: async () => ({ data: { ses_verify: { type: "idle" } } }),
      messages: async () => ({
        data: [{
          info: { id: `assistant_${messageID}`, role: "assistant", parentID: messageID, time: { completed: Date.now() }, tokens: { output: 1 } },
          parts: [{ id: `part_${messageID}`, messageID: `assistant_${messageID}`, type: "text", text: "done" }],
        }],
      }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<Event> {
          if (event !== undefined) yield event;
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
      }),
    },
    permission: {
      reply: async () => ({ data: {} }),
    },
  } as unknown as OpencodeClient;
  return { client, prompts };
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of graceKeys) {
    const value = savedGrace.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalGateMaxMs === undefined) delete process.env.LOOPER_PERMISSION_GATE_MAX_MS;
  else process.env.LOOPER_PERMISSION_GATE_MAX_MS = originalGateMaxMs;
});

describe("runIteration outcome wiring", () => {
  test("sends one same-session reminder and accepts the resulting phase signal", async () => {
    // Given an expecting step whose first completed turn emits no outcome.
    const scratch = setup();
    const storyState = createStoryStateStore({ configDir: scratch.configDir });
    const stub = clientFor(scratch.repoDir, (_prompt, call) => {
      if (call !== 2) return;
      storyState.writePhase("US-1", "reviewed");
      appendSignal(scratch.configDir, { kind: "story-phase", storyId: "US-1", phase: "reviewed" });
    });

    // When the iteration evaluates both completed turns.
    const result = await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Verify"] }), iteration: 1, client: stub.client, ...scratch, storyState });

    // Then exactly one outcome-only follow-up completes the step.
    expect(result).toBe("complete");
    expect(stub.prompts).toHaveLength(2);
    expect(stub.prompts[1]).not.toContain("<looper-context>");
    expect(storyState.readPhase("US-1")).toBe("reviewed");
  }, 30_000);

  test("records a blocked signal as an advancing blocked completion", async () => {
    // Given an expecting step that reports an external blocker.
    const scratch = setup();
    const state = createLoopState({ maxIterations: 1, stepNames: ["Verify"] });
    const completions: string[] = [];
    const stub = clientFor(scratch.repoDir, () => appendSignal(scratch.configDir, { kind: "blocked", storyId: "US-1", reason: "CI unavailable" }));

    // When the step completes its first turn.
    await runIteration({ state, iteration: 1, client: stub.client, ...scratch, hooks: { onStepFinish: ({ completionKind }) => completions.push(completionKind) } });

    // Then it advances without a reminder or failure.
    expect(stub.prompts).toHaveLength(1);
    expect(completions).toEqual(["blocked"]);
    expect(state.steps[0]?.status).toBe("skipped");
    expect(state.steps[0]?.statusMessage).toBe("blocked: CI unavailable");
  }, 30_000);

  test("fails without retry when the reminder also emits no outcome", async () => {
    // Given an expecting step that never signals an outcome.
    const scratch = setup();
    const stub = clientFor(scratch.repoDir, () => {});

    // When both the original turn and its one reminder complete unsignaled.
    const error = await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Verify"] }), iteration: 1, client: stub.client, ...scratch }).then<unknown>(() => undefined, (caught) => caught);

    // Then the step fails closed after exactly two turns.
    expect(error).toBeInstanceOf(StepFailureError);
    expect(stub.prompts).toHaveLength(2);
  }, 30_000);

  test("turns a permission gate timeout into blocked without sending a reminder", async () => {
    // Given an attended permission ask whose human gate expires.
    process.env.LOOPER_PERMISSION_GATE_MAX_MS = "1";
    const scratch = setup();
    const state = createLoopState({ maxIterations: 1, stepNames: ["Verify"] });
    const stub = clientFor(scratch.repoDir, () => {}, permissionAsked());

    // When the request broker rejects the expired ask.
    await runIteration({ state, iteration: 1, client: stub.client, ...scratch });

    // Then outcome enforcement records the engine blocker directly.
    expect(stub.prompts).toHaveLength(1);
    expect(state.steps[0]?.statusMessage).toBe("blocked: permission gate timed out: external_directory");
  }, 30_000);

  test("resets a later stored phase to expects when the step creates a commit", async () => {
    // Given a reviewed step with a stale later stored phase.
    const scratch = setup();
    const storyState = createStoryStateStore({ configDir: scratch.configDir });
    storyState.writePhase("US-1", "verified");
    const stub = clientFor(scratch.repoDir, () => {
      writeFileSync(join(scratch.repoDir, "change.txt"), "change\n");
      Bun.spawnSync(["git", "add", "change.txt"], { cwd: scratch.repoDir });
      Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "change"], { cwd: scratch.repoDir });
    });

    // When the expecting step completes after HEAD advances without any outcome signal.
    const error = await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Verify"] }), iteration: 1, client: stub.client, ...scratch, storyState }).then<unknown>(() => undefined, (caught) => caught);

    // Then the stale phase is reset below `expects` BEFORE the outcome decision,
    // so it cannot satisfy it: the step is reminded once and then fails closed.
    expect(storyState.readPhase("US-1")).toBe("implemented");
    expect(stub.prompts).toHaveLength(2);
    expect(stub.prompts[1]).toContain("ended without an outcome signal");
    expect(error).toBeInstanceOf(StepFailureError);
  }, 30_000);

  test("records a commit-driven phase reset only as an engine transition", async () => {
    // Given a stale reviewed phase and adjudication history tracking.
    const scratch = setup();
    const storyState = createStoryStateStore({ configDir: scratch.configDir });
    const adjudicationStore = createAdjudicationStore({ configDir: scratch.configDir });
    storyState.writePhase("US-1", "verified");
    const stub = clientFor(scratch.repoDir, (_prompt, call) => {
      if (call !== 1) return;
      writeFileSync(join(scratch.repoDir, "change.txt"), "change\n");
      Bun.spawnSync(["git", "add", "change.txt"], { cwd: scratch.repoDir });
      Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "change"], { cwd: scratch.repoDir });
    });

    // When the commit resets the stale phase during outcome evaluation.
    await runIteration({
      state: createLoopState({ maxIterations: 1, stepNames: ["Verify"] }),
      iteration: 1,
      client: stub.client,
      ...scratch,
      storyState,
      adjudication: { store: adjudicationStore, threshold: 2, writeStop: () => {} },
    }).then<unknown>(() => undefined, (caught) => caught);

    // Then adjudication history attributes the transition to the engine once.
    expect(adjudicationStore.readHistory().map(({ from, to, source }) => ({ from, to, source }))).toEqual([
      { from: "verified", to: "implemented", source: "engine" },
    ]);
  }, 30_000);

  test("does not let setsPhase erase an accepted demotion", async () => {
    // Given a phase-setting step whose agent explicitly hands the story back.
    const scratch = setup();
    writeFileSync(join(scratch.configDir, "looper.yaml"), "steps:\n  verify:\n    prompt: step.md\n    expects: reviewed\n    setsPhase: reviewed\n");
    const storyState = createStoryStateStore({ configDir: scratch.configDir });
    storyState.writePhase("US-1", "implemented");
    const stub = clientFor(scratch.repoDir, () => {
      storyState.writePhase("US-1", "building");
      appendSignal(scratch.configDir, { kind: "story-phase", storyId: "US-1", phase: "building", reason: "review failed" });
    });

    // When outcome enforcement accepts the demotion signal.
    await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Verify"] }), iteration: 1, client: stub.client, ...scratch, storyState });

    // Then automatic phase-setting cannot re-promote the failed story.
    expect(storyState.readPhase("US-1")).toBe("building");
  }, 30_000);

  test("rejects a setsPhase later than the step's expects", () => {
    // Given a step whose configured setsPhase would outrun what the step proves.
    const scratch = setup();
    writeFileSync(join(scratch.configDir, "looper.yaml"), "steps:\n  verify:\n    prompt: step.md\n    expects: reviewed\n    setsPhase: verified\n");

    // Then the config loader refuses it up front.
    expect(() => loadSteps(scratch.configDir)).toThrow(/setsPhase \(verified\) must not be later than .*expects \(reviewed\)/);
  });

  test("compares hand-back signals against the post-step branch story's start phase", async () => {
    // Start on main so the selected next story is US-1, then switch onto US-2.
    const scratch = setup("implemented");
    writeFileSync(join(scratch.prdDir, "prd.json"), JSON.stringify({
      userStories: [
        { id: "US-1", title: "One", priority: 1, dependsOn: [] },
        { id: "US-2", title: "Two", priority: 2, dependsOn: [] },
      ],
    }));
    Bun.spawnSync(["git", "checkout", "-q", "-b", "main"], { cwd: scratch.repoDir });
    const storyState = createStoryStateStore({ configDir: scratch.configDir });
    storyState.writePhase("US-2", "reviewed");
    const stub = clientFor(scratch.repoDir, () => {
      Bun.spawnSync(["git", "checkout", "-q", "-b", "us-2-work"], { cwd: scratch.repoDir });
      storyState.writePhase("US-2", "building");
      appendSignal(scratch.configDir, { kind: "story-phase", storyId: "US-2", phase: "building", reason: "needs rebuild" });
    });

    await runIteration({ state: createLoopState({ maxIterations: 1, stepNames: ["Verify"] }), iteration: 1, client: stub.client, ...scratch, storyState });

    expect(stub.prompts).toHaveLength(1);
    expect(storyState.readPhase("US-2")).toBe("building");
    expect(storyState.readPhase("US-1")).toBeUndefined();
  }, 30_000);
});
