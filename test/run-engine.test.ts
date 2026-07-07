import { describe, expect, test } from "bun:test";

import { computeRunResumePlan, runEngine } from "../src/engine/run-engine.ts";
import type { EngineFrontendHooks, RunStateStore } from "../src/engine/engine-ports.ts";
import type { RunState } from "../src/lib/state-files.ts";

type Step = { readonly name: string; readonly prompt: string };

function memoryStore(initial: RunState | null = null): RunStateStore {
  let state = initial;
  return {
    read: () => state,
    saveResumeStep: () => {},
    saveNextResumeStep: () => {},
    savePosition: (input) => {
      const step = input.steps[input.stepIndex];
      const stepName = input.stepName ?? step?.name;
      if (stepName === undefined) return;
      state = { iteration: input.iteration, stepIndex: input.stepIndex, stepName, updatedAt: "now", ...(input.title !== undefined ? { title: input.title } : {}), ...(input.looperRunID !== undefined ? { looperRunID: input.looperRunID } : {}), ...(input.stepSessions !== undefined ? { stepSessions: input.stepSessions } : {}), ...(input.sessionID !== undefined ? { sessionID: input.sessionID } : {}), ...(input.messageID !== undefined ? { messageID: input.messageID } : {}) };
    },
    saveAdvance: (input) => {
      const first = input.steps[0];
      const next = input.steps[input.nextIndex];
      if (first === undefined) {
        state = null;
        return;
      }
      if (next === undefined) {
        state = { iteration: input.iteration + 1, stepIndex: 0, stepName: first.name, updatedAt: "now", ...(input.looperRunID !== undefined ? { looperRunID: input.looperRunID } : {}) };
        return;
      }
      state = { iteration: input.iteration, stepIndex: input.nextIndex, stepName: next.name, updatedAt: "now", ...(input.title !== undefined ? { title: input.title } : {}), ...(input.looperRunID !== undefined ? { looperRunID: input.looperRunID } : {}), ...(input.stepSessions !== undefined ? { stepSessions: input.stepSessions } : {}) };
    },
    clearForFreshRun: () => { state = null; },
    clearRunArtifacts: () => { state = null; },
    clearStopFiles: () => {},
    stopReason: () => "stop requested",
    stopFileExists: () => false,
    stopAfterIterationFileExists: () => false,
    writeStop: () => {},
    writeStopAfterIteration: () => {},
  };
}

describe("computeRunResumePlan", () => {
  test("fresh ignores persisted run-state", () => {
    const store = memoryStore({ iteration: 3, stepIndex: 1, stepName: "review", sessionID: "ses", messageID: "msg", updatedAt: "now" });
    const plan = computeRunResumePlan({ fresh: true, maxIterations: 5, steps: [{ name: "build" }, { name: "review" }], store, legacyResumeStepIndex: () => 0 });
    expect(plan.startIteration).toBe(1);
    expect(plan.firstIterationStartStepIndex).toBe(0);
    expect(plan.firstIterationResume).toBeUndefined();
    expect(plan.resumed).toBe(false);
  });

  test("run-state resumes by step name with title, session, and prior step sessions", () => {
    const store = memoryStore({ iteration: 2, stepIndex: 0, stepName: "review", sessionID: "ses", messageID: "msg", title: "work", looperRunID: "run-old", stepSessions: [{ stepIndex: 0, stepName: "build", sessionID: "ses-build" }], updatedAt: "now" });
    const plan = computeRunResumePlan({ fresh: false, maxIterations: 5, steps: [{ name: "build" }, { name: "review" }], store, legacyResumeStepIndex: () => 0 });
    expect(plan.startIteration).toBe(2);
    expect(plan.firstIterationStartStepIndex).toBe(1);
    expect(plan.firstIterationResume).toEqual({ sessionID: "ses", messageID: "msg", stepName: "review" });
    expect(plan.firstIterationTitle).toBe("work");
    expect(plan.firstIterationStepSessions).toEqual([{ stepIndex: 0, stepName: "build", sessionID: "ses-build" }]);
    expect(plan.looperRunID).toBe("run-old");
  });

  test("max-iterations-exceeded resets to a fresh run and asks the store to clear artifacts", () => {
    const store = memoryStore({ iteration: 9, stepIndex: 1, stepName: "review", updatedAt: "now" });
    const plan = computeRunResumePlan({ fresh: false, maxIterations: 2, steps: [{ name: "build" }, { name: "review" }], store, legacyResumeStepIndex: () => 1 });
    expect(plan.resetToFreshRun).toBe(true);
    expect(plan.startIteration).toBe(1);
    expect(plan.firstIterationStartStepIndex).toBe(0);
    expect(store.read()).toBeNull();
  });
});

describe("runEngine", () => {
  test("persists session bind, step advance, and drops title/stepSessions at iteration boundary", async () => {
    const store = memoryStore();
    const calls: string[] = [];
    const steps: Step[] = [{ name: "build", prompt: "build.md" }, { name: "review", prompt: "review.md" }];
    const hooks: EngineFrontendHooks<{ readonly iteration: number }> = {
      createIterationState: ({ iteration }) => ({ iteration }),
      onIterationStart: ({ iteration }) => {
        calls.push(`iteration:${iteration}`);
      },
    };
    await runEngine({ maxIterations: 2, fresh: false, waitProvided: false, waitDuration: 0, repoDir: "/repo", configDir: "/cfg", client: {}, store, hooks, loadSteps: () => steps, currentBranch: async () => "main", createLooperRunID: () => "run-1", legacyResumeStepIndex: () => 0, runIteration: async (input) => { input.hooks?.onStepBegin?.({ step: steps[0]!, index: 0, totalSteps: 2, iteration: input.iteration, title: "title" }); input.hooks?.onStepSession?.({ iteration: input.iteration, index: 0, stepName: "build", sessionID: `ses-${input.iteration}`, messageID: `msg-${input.iteration}`, title: "title" }); input.hooks?.onStepFinish?.({ step: steps[0]!, index: 0, nextIndex: 2, totalSteps: 2, iteration: input.iteration, status: "done", title: "title" }); return "complete"; } });
    expect(calls).toEqual(["iteration:1", "iteration:2"]);
    expect(store.read()).toBeNull();
  });

  test("honors stop file before starting an iteration", async () => {
    let stopped = true;
    const store = { ...memoryStore(), stopFileExists: () => stopped, stopReason: () => "asked" } satisfies RunStateStore;
    let ran = false;
    const result = await runEngine({ maxIterations: 1, fresh: false, waitProvided: false, waitDuration: 0, repoDir: "/repo", configDir: "/cfg", client: {}, store, hooks: { createIterationState: () => ({}) }, loadSteps: () => [{ name: "build", prompt: "build.md" }], currentBranch: async () => "main", createLooperRunID: () => "run", legacyResumeStepIndex: () => 0, runIteration: async () => { ran = true; return "complete"; } });
    stopped = false;
    expect(result.kind).toBe("stopped");
    expect(ran).toBe(false);
  });

  test("honors stop-after-iteration after a completed iteration", async () => {
    let stopAfter = false;
    const store = { ...memoryStore(), stopAfterIterationFileExists: () => stopAfter } satisfies RunStateStore;
    let runs = 0;
    const result = await runEngine({ maxIterations: 3, fresh: false, waitProvided: false, waitDuration: 0, repoDir: "/repo", configDir: "/cfg", client: {}, store, hooks: { createIterationState: () => ({}) }, loadSteps: () => [{ name: "build", prompt: "build.md" }], currentBranch: async () => "main", createLooperRunID: () => "run", legacyResumeStepIndex: () => 0, runIteration: async () => { runs += 1; stopAfter = true; return "complete"; } });
    expect(result.kind).toBe("stopped");
    expect(runs).toBe(1);
  });

  test("invokes wait between iterations using the completed iteration duration", async () => {
    const waits: number[] = [];
    await runEngine({ maxIterations: 2, fresh: false, waitProvided: true, waitDuration: "execution-time", repoDir: "/repo", configDir: "/cfg", client: {}, store: memoryStore(), hooks: { createIterationState: () => ({}), waitBetweenIterations: async ({ seconds }) => { waits.push(seconds); } }, loadSteps: () => [{ name: "build", prompt: "build.md" }], currentBranch: async () => "main", createLooperRunID: () => "run", legacyResumeStepIndex: () => 0, elapsedSeconds: () => 7, runIteration: async () => "complete" });
    expect(waits).toEqual([7, 7]);
  });
});
