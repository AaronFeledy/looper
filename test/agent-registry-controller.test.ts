import { afterEach, describe, expect, test } from "bun:test";

import { startAgentRegistryController } from "../src/lib/agent-registry-controller.ts";
import { cancelPendingNotify, createLoopState, notify, type LoopState, type StepStatus } from "../src/lib/state.ts";
import type { ProjectedAgent } from "../src/core/agent-registry.ts";
import type { AgentRegistry } from "../src/opencode/agent-registry.ts";

type FakeRegistry = {
  readonly registry: AgentRegistry;
  readonly rootCalls: string[][];
  readonly projectCalls: string[];
  readonly listeners: Set<() => void>;
  readonly emit: () => void;
  readonly stopCalls: () => number;
};

const CHILD: ProjectedAgent = {
  sessionID: "ses_child",
  parentSessionID: "ses_root",
  depth: 1,
  activity: "busy",
  startedAt: 10,
};

function createState(status: StepStatus, sessionID?: string, names = ["build"]): LoopState {
  const state = createLoopState({ maxIterations: 1, stepNames: names });
  const step = state.steps[0];
  if (step === undefined) throw new TypeError("Expected a step fixture");
  step.status = status;
  if (sessionID !== undefined) step.sessionID = sessionID;
  return state;
}

function createFakeRegistry(projects: ReadonlyMap<string, ProjectedAgent[]> = new Map()): FakeRegistry {
  const rootCalls: string[][] = [];
  const projectCalls: string[] = [];
  const listeners = new Set<() => void>();
  let stops = 0;
  const registry: AgentRegistry = {
    setRoots: (roots) => rootCalls.push([...roots]),
    projectRoot: (sessionID) => {
      projectCalls.push(sessionID);
      return projects.get(sessionID) ?? [];
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: () => {
      stops += 1;
    },
  };
  return {
    registry,
    rootCalls,
    projectCalls,
    listeners,
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
    stopCalls: () => stops,
  };
}

afterEach(() => {
  cancelPendingNotify();
});

describe("startAgentRegistryController", () => {
  test("leases a running step with a session", () => {
    // Given
    const state = createState("running", "ses_root");
    const fake = createFakeRegistry();

    // When
    const controller = startAgentRegistryController({ state, registry: fake.registry });

    // Then
    expect(fake.rootCalls).toEqual([["ses_root"]]);
    expect(fake.projectCalls).toEqual(["ses_root"]);
    controller.stop();
  });

  test("leases a waiting step with a session", () => {
    // Given
    const state = createState("waiting", "ses_waiting");
    const fake = createFakeRegistry();

    // When
    const controller = startAgentRegistryController({ state, registry: fake.registry });

    // Then
    expect(fake.rootCalls).toEqual([["ses_waiting"]]);
    controller.stop();
  });

  test("does not lease pending or terminal steps", () => {
    for (const status of ["pending", "done", "failed", "skipped"] as const) {
      // Given
      const state = createState(status, `ses_${status}`);
      const fake = createFakeRegistry();

      // When
      const controller = startAgentRegistryController({ state, registry: fake.registry });

      // Then
      expect(fake.rootCalls).toEqual([]);
      expect(fake.projectCalls).toEqual([]);
      controller.stop();
    }
  });

  test("projects two concurrent leases", () => {
    // Given
    const state = createState("running", "ses_first", ["build", "review"]);
    const second = state.steps[1];
    if (second === undefined) throw new TypeError("Expected the review step fixture");
    second.status = "waiting";
    second.sessionID = "ses_second";
    const fake = createFakeRegistry();

    // When
    const controller = startAgentRegistryController({ state, registry: fake.registry });

    // Then
    expect(fake.rootCalls).toEqual([["ses_first", "ses_second"]]);
    expect(fake.projectCalls).toEqual(["ses_first", "ses_second"]);
    controller.stop();
  });

  test("prunes agents when a leased step becomes done", async () => {
    // Given
    const state = createState("running", "ses_root");
    const fake = createFakeRegistry(new Map([["ses_root", [CHILD]]]));
    const controller = startAgentRegistryController({ state, registry: fake.registry });
    const step = state.steps[0];
    if (step === undefined) throw new TypeError("Expected a step fixture");
    expect(step.backgroundAgents).toHaveLength(1);

    // When
    step.status = "done";
    notify();
    await Bun.sleep(50);

    // Then
    expect(step.backgroundAgents).toEqual([]);
    expect(fake.rootCalls).toEqual([["ses_root"], []]);
    controller.stop();
  });

  test("preserves agents when a leased step becomes failed or skipped", async () => {
    for (const status of ["failed", "skipped"] as const) {
      // Given
      const state = createState("running", "ses_root");
      const fake = createFakeRegistry(new Map([["ses_root", [CHILD]]]));
      const controller = startAgentRegistryController({ state, registry: fake.registry });
      const step = state.steps[0];
      if (step === undefined) throw new TypeError("Expected a step fixture");
      expect(step.backgroundAgents).toHaveLength(1);

      // When
      step.status = status;
      notify();
      await Bun.sleep(50);

      // Then
      expect(step.backgroundAgents).toHaveLength(1);
      expect(step.backgroundAgents[0]?.sessionID).toBe(CHILD.sessionID);
      expect(fake.rootCalls).toEqual([["ses_root"], []]);
      controller.stop();
    }
  });

  test("bounds syncs when tree updates notify state listeners", async () => {
    // Given
    const state = createState("running", "ses_root");
    const fake = createFakeRegistry(new Map([["ses_root", [CHILD]]]));

    // When
    const controller = startAgentRegistryController({ state, registry: fake.registry });
    await Bun.sleep(50);

    // Then
    expect(fake.projectCalls.length).toBeLessThanOrEqual(3);
    controller.stop();
  });

  test("does not set roots when the lease set is unchanged", () => {
    // Given
    const state = createState("running", "ses_root");
    const fake = createFakeRegistry();
    const controller = startAgentRegistryController({ state, registry: fake.registry });

    // When
    fake.emit();

    // Then
    expect(fake.rootCalls).toEqual([["ses_root"]]);
    expect(fake.projectCalls).toEqual(["ses_root", "ses_root"]);
    controller.stop();
  });

  test("stop unsubscribes both listeners without stopping the registry", async () => {
    // Given
    const state = createState("running", "ses_root");
    const fake = createFakeRegistry();
    const controller = startAgentRegistryController({ state, registry: fake.registry });
    fake.projectCalls.length = 0;

    // When
    controller.stop();
    controller.stop();
    fake.emit();
    notify();
    await Bun.sleep(50);

    // Then
    expect(fake.listeners.size).toBe(0);
    expect(fake.projectCalls).toEqual([]);
    expect(fake.stopCalls()).toBe(0);
  });
});
