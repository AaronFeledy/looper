import { describe, expect, test } from "bun:test";

import { runEngine } from "../src/engine/run-engine.ts";
import type { RunStateStore } from "../src/engine/engine-ports.ts";
import type { StoryPhaseResolver, StoryPhaseSnapshot } from "../src/engine/story-phases.ts";

const COMPLETE: StoryPhaseSnapshot = {
  stories: [{ id: "US-1", dependsOn: [] }],
  phases: { "US-1": "merged" },
  terminal: "merged",
};

const INCOMPLETE: StoryPhaseSnapshot = {
  stories: COMPLETE.stories,
  phases: { "US-1": "verified" },
  terminal: "merged",
};

function memoryStore(stopReasons: string[]): RunStateStore {
  return {
    read: () => null,
    saveResumeStep: () => {},
    saveNextResumeStep: () => {},
    savePosition: () => {},
    saveAdvance: () => {},
    clearForFreshRun: () => {},
    clearRunArtifacts: () => {},
    clearStopFiles: () => {},
    stopReason: () => stopReasons.at(-1) ?? "stop requested",
    stopFileExists: () => false,
    stopAfterIterationFileExists: () => false,
    writeStop: (reason) => stopReasons.push(reason),
    writeStopAfterIteration: () => {},
  };
}

function resolver(snapshots: readonly (StoryPhaseSnapshot | undefined)[], fetches: { count: number }): StoryPhaseResolver {
  let index = 0;
  return {
    fetchMain: async () => {
      fetches.count += 1;
    },
    snapshot: () => snapshots[Math.min(index++, snapshots.length - 1)],
  };
}

function engineInput(storyResolver: StoryPhaseResolver, stopReasons: string[], runIteration: () => Promise<"complete">) {
  return {
    maxIterations: 1,
    fresh: false,
    waitProvided: false,
    waitDuration: 0,
    repoDir: "/repo",
    configDir: "/cfg",
    client: {},
    store: memoryStore(stopReasons),
    hooks: { createIterationState: () => ({}) },
    loadSteps: () => [{ name: "Build", prompt: "build.md" }],
    currentBranch: async () => "main",
    createLooperRunID: () => "run",
    legacyResumeStepIndex: () => 0,
    storyResolver,
    runIteration,
  } as const;
}

describe("runEngine PRD termination", () => {
  test("stops before step zero when every story is terminal", async () => {
    const stopReasons: string[] = [];
    const fetches = { count: 0 };
    let iterations = 0;

    const result = await runEngine(engineInput(resolver([COMPLETE], fetches), stopReasons, async () => {
      iterations += 1;
      return "complete";
    }));

    expect(result).toEqual({ kind: "stopped", reason: "PRD complete: 1/1 stories at phase merged" });
    expect(stopReasons).toEqual(["PRD complete: 1/1 stories at phase merged"]);
    expect(iterations).toBe(0);
    expect(fetches.count).toBe(1);
  });

  test("stops at the iteration boundary when the last story becomes terminal", async () => {
    const stopReasons: string[] = [];
    const fetches = { count: 0 };
    let iterations = 0;

    const result = await runEngine(engineInput(resolver([INCOMPLETE, COMPLETE], fetches), stopReasons, async () => {
      iterations += 1;
      return "complete";
    }));

    expect(result.kind).toBe("stopped");
    expect(stopReasons).toEqual(["PRD complete: 1/1 stories at phase merged"]);
    expect(iterations).toBe(1);
    expect(fetches.count).toBe(2);
  });

  test.each([
    ["an unreadable PRD", undefined],
    ["an empty PRD", { stories: [], phases: {}, terminal: "merged" } satisfies StoryPhaseSnapshot],
  ] as const)("fails open for %s", async (_label, snapshot) => {
    const stopReasons: string[] = [];
    const fetches = { count: 0 };
    let iterations = 0;

    const result = await runEngine(engineInput(resolver([snapshot], fetches), stopReasons, async () => {
      iterations += 1;
      return "complete";
    }));

    expect(result.kind).toBe("max-iterations");
    expect(stopReasons).toEqual([]);
    expect(iterations).toBe(1);
    expect(fetches.count).toBe(2);
  });
});
