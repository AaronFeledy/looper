import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { runEngine } from "../src/engine/run-engine.ts";
import { runNonTtyIterations } from "../src/lib/fallback.ts";
import { runIteration } from "../src/lib/orchestrator.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createAdjudicationStore } from "../src/persistence/adjudication-store.ts";
import { createRunStateStore } from "../src/persistence/run-state-store.ts";
import { createInMemoryAdjudicationStore } from "./helpers/adjudication-stub.ts";

type Scratch = { readonly repoDir: string; readonly configDir: string; readonly prdDir: string };

const scratchDirs: string[] = [];

function setup(stepCount: number, adjudicate = true): Scratch {
  const repoDir = join(import.meta.dir, ".tmp", `adjudication-${crypto.randomUUID()}`);
  const configDir = join(repoDir, ".looper");
  const prdDir = join(repoDir, "spec");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(prdDir, { recursive: true });
  initStatePaths({ configDir });
  const lines = ["steps:"];
  for (let index = 0; index < stepCount; index += 1) {
    const key = `step${index + 1}`;
    writeFileSync(join(configDir, `${key}.md`), `${key} prompt\n`);
    lines.push(`  ${key}:`, `    prompt: ${key}.md`);
  }
  if (adjudicate) {
    writeFileSync(join(configDir, "adjudicate.md"), "resolve the PRD conflict\n");
    lines.push("adjudicate:", "  prompt: adjudicate.md");
  }
  writeFileSync(join(configDir, "looper.yaml"), `${lines.join("\n")}\n`);
  writePrd(prdDir, true);
  scratchDirs.push(repoDir);
  return { repoDir, configDir, prdDir };
}

function writePrd(prdDir: string, passes: boolean): void {
  writeFileSync(join(prdDir, "prd.json"), JSON.stringify({ userStories: [{ id: "story-1", passes }] }));
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function clientFor(repoDir: string, onPrompt?: (prompt: string, ordinal: number) => void): { readonly client: OpencodeClient; readonly prompts: string[] } {
  const prompts: string[] = [];
  const sessionIDs: string[] = [];
  const client = {
    session: {
      create: async () => {
        const id = `ses_${sessionIDs.length + 1}`;
        sessionIDs.push(id);
        return { data: { id } };
      },
      prompt: async (params: { sessionID: string; parts: { text: string }[] }) => {
        const text = params.parts.map((part) => part.text).join("\n");
        prompts.push(text);
        onPrompt?.(text, prompts.length);
        const dir = join(repoDir, ".omo", "run-continuation");
        mkdirSync(dir, { recursive: true });
        const at = new Date().toISOString();
        writeFileSync(join(dir, `${params.sessionID}.json`), JSON.stringify({ sessionID: params.sessionID, updatedAt: at, sources: { "background-task": { state: "idle", updatedAt: at } } }));
        return { data: {} };
      },
      status: async () => ({ data: Object.fromEntries(sessionIDs.map((id) => [id, { type: "idle" }])) }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> {
          await waitForAbort(options.signal);
        })(),
      }),
    },
  } as unknown as OpencodeClient;
  return { client, prompts };
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PRD adjudication routing", () => {
  test("accrues passes transitions across normal steps", async () => {
    const scratch = setup(3);
    const store = createInMemoryAdjudicationStore();
    const stub = clientFor(scratch.repoDir, (_prompt, ordinal) => writePrd(scratch.prdDir, ordinal % 2 === 0));
    const state = createLoopState({ maxIterations: 1, stepNames: ["Step1", "Step2", "Step3"] });

    await runIteration({ state, iteration: 1, client: stub.client, ...scratch, adjudication: { store, step: undefined, threshold: 99, writeStop: () => {} } });

    expect(store.readHistory().map(({ from, to, stepName }) => ({ from, to, stepName }))).toEqual([
      { from: true, to: false, stepName: "Step1" },
      { from: false, to: true, stepName: "Step2" },
      { from: true, to: false, stepName: "Step3" },
    ]);
  });

  test("threshold routes to adjudicate, skips the remainder, clears the marker, and keeps the row ephemeral", async () => {
    const scratch = setup(4);
    const store = createInMemoryAdjudicationStore();
    const stub = clientFor(scratch.repoDir, (prompt, ordinal) => {
      if (!prompt.includes("resolve the PRD conflict")) writePrd(scratch.prdDir, ordinal % 2 === 0);
    });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Step1", "Step2", "Step3", "Step4"] });

    await runIteration({ state, iteration: 1, client: stub.client, ...scratch, adjudication: { store, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} } });

    expect(store.readMarker()).toBeNull();
    expect(stub.prompts.at(-1)).toContain("resolve the PRD conflict");
    expect(state.steps.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: "Step1", status: "done" }, { name: "Step2", status: "done" },
      { name: "Step3", status: "done" }, { name: "Step4", status: "skipped" },
      { name: "adjudicate", status: "done" },
    ]);

    const nextStub = clientFor(scratch.repoDir);
    const nextState = createLoopState({ maxIterations: 2, stepNames: ["Step1", "Step2", "Step3", "Step4"] });
    await runIteration({ state: nextState, iteration: 2, client: nextStub.client, ...scratch, adjudication: { store, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} } });
    expect(nextStub.prompts[0]).toContain("step1 prompt");
    expect(nextState.steps.map((step) => step.name)).toEqual(["Step1", "Step2", "Step3", "Step4"]);
  });

  test("advances the history watermark on a completed adjudication so resolved flips stop counting", async () => {
    // Given a step sequence that oscillates and then resolves via adjudication.
    const scratch = setup(3);
    const store = createInMemoryAdjudicationStore();
    const stub = clientFor(scratch.repoDir, (prompt, ordinal) => {
      if (!prompt.includes("resolve the PRD conflict")) writePrd(scratch.prdDir, ordinal % 2 === 0);
    });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Step1", "Step2", "Step3"] });

    await runIteration({ state, iteration: 1, client: stub.client, ...scratch, adjudication: { store, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} } });

    // Then the marker is cleared, the full trail is retained, and detection's active window is emptied.
    expect(store.readMarker()).toBeNull();
    expect(store.readHistory().length).toBeGreaterThanOrEqual(2);
    expect(store.readActiveHistory()).toEqual([]);
  });

  test("does not re-route from flips a prior adjudication already resolved", async () => {
    // Given two qualifying flips that a prior adjudication already marked resolved.
    const scratch = setup(1);
    const store = createInMemoryAdjudicationStore();
    store.appendHistory([
      { storyId: "story-1", from: true, to: false, iteration: 1, stepName: "prior", at: "2026-07-18T00:00:01.000Z" },
      { storyId: "story-1", from: true, to: false, iteration: 1, stepName: "prior", at: "2026-07-18T00:00:02.000Z" },
    ]);
    store.markAdjudicated();
    const stub = clientFor(scratch.repoDir, () => writePrd(scratch.prdDir, false));
    const state = createLoopState({ maxIterations: 1, stepNames: ["Step1"] });

    // When a single new true->false flip accrues after the watermark.
    await runIteration({ state, iteration: 1, client: stub.client, ...scratch, adjudication: { store, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} } });

    // Then it stays below threshold in the active window, so no adjudication is routed.
    expect(store.markerExists()).toBeFalse();
    expect(stub.prompts.some((prompt) => prompt.includes("resolve the PRD conflict"))).toBeFalse();
  });

  test("routes an agent-written marker without oscillation detection", async () => {
    const scratch = setup(2);
    const store = createInMemoryAdjudicationStore();
    const stub = clientFor(scratch.repoDir, (_prompt, ordinal) => {
      if (ordinal === 1) store.writeMarker("agent requested adjudication");
    });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Step1", "Step2"] });

    await runIteration({ state, iteration: 1, client: stub.client, ...scratch, adjudication: { store, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} } });

    expect(stub.prompts).toHaveLength(2);
    expect(stub.prompts[1]).toContain("resolve the PRD conflict");
    expect(state.steps[1]?.status).toBe("skipped");
  });

  test("writes a stop reason when no adjudicate step is configured", async () => {
    const scratch = setup(2, false);
    const store = createInMemoryAdjudicationStore();
    const stopReasons: string[] = [];
    const stub = clientFor(scratch.repoDir, () => store.writeMarker("contract conflict"));
    const state = createLoopState({ maxIterations: 1, stepNames: ["Step1", "Step2"] });

    await runIteration({ state, iteration: 1, client: stub.client, ...scratch, adjudication: { store, threshold: 2, writeStop: (reason: string) => stopReasons.push(reason) } });

    expect(stopReasons).toEqual(["contract conflict"]);
    expect(store.readMarker()).toBeNull();
  });

  test("clears a marker written by the adjudicator without recursing", async () => {
    const scratch = setup(2);
    const store = createInMemoryAdjudicationStore();
    const stub = clientFor(scratch.repoDir, (prompt, ordinal) => {
      if (ordinal === 1) store.writeMarker("route once");
      if (prompt.includes("resolve the PRD conflict")) store.writeMarker("do not recurse");
    });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Step1", "Step2"] });

    await runIteration({ state, iteration: 1, client: stub.client, ...scratch, adjudication: { store, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} } });

    expect(stub.prompts.filter((prompt) => prompt.includes("resolve the PRD conflict"))).toHaveLength(1);
    expect(store.readMarker()).toBeNull();
  });

  test("a stale marker routes before step zero and never persists adjudicate as the resume step", async () => {
    const scratch = setup(1);
    const adjudicationStore = createInMemoryAdjudicationStore();
    adjudicationStore.writeMarker("resume adjudication");
    const runStateStore = createRunStateStore({ configDir: scratch.configDir });
    const stub = clientFor(scratch.repoDir, (prompt) => {
      expect(prompt).toContain("resolve the PRD conflict");
      const path = join(scratch.configDir, ".looper-run.json");
      expect(existsSync(path) ? readFileSync(path, "utf8") : "").not.toContain("adjudicate");
    });

    await runEngine({ fresh: false, maxIterations: 1, waitProvided: false, waitDuration: 0, ...scratch, client: stub.client, store: runStateStore, hooks: { createIterationState: () => createLoopState({ maxIterations: 1, stepNames: ["Step1"] }) }, loadSteps: () => [{ name: "Step1", prompt: join(scratch.configDir, "step1.md") }], currentBranch: async () => "main", createLooperRunID: () => "run", legacyResumeStepIndex: () => 0, runIteration, adjudication: { store: adjudicationStore, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2 } });

    expect(stub.prompts).toHaveLength(1);
  });

  test("the non-TTY frontend constructs and injects file-backed adjudication", async () => {
    const scratch = setup(1);
    createAdjudicationStore({ configDir: scratch.configDir }).writeMarker("fallback route");
    const stub = clientFor(scratch.repoDir, () => createRunStateStore({ configDir: scratch.configDir }).writeStop("adjudication complete"));

    await runNonTtyIterations({ options: { attach: false, fresh: false, init: false, start: true, maxIterations: 1, waitProvided: false, waitDuration: 0 }, ...scratch, client: stub.client, recoverySnapshots: false, currentBranch: async () => "main" });

    expect(stub.prompts).toHaveLength(1);
    expect(stub.prompts[0]).toContain("resolve the PRD conflict");
  });
});
