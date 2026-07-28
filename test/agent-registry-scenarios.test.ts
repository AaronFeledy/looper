import { afterEach, describe, expect, test } from "bun:test";

import { setStepContinuation } from "../src/lib/agent-tree-state.ts";
import { startAgentRegistryController } from "../src/lib/agent-registry-controller.ts";
import { startBackgroundAgentStreamer } from "../src/lib/background-agent-stream.ts";
import { waitForLoopContinuationIdle } from "../src/lib/runner.ts";
import {
  cancelPendingNotify,
  createLoopState,
  flattenRows,
  notify,
  selectNextStep,
  selectStepListRow,
  subscribe,
  type LoopState,
} from "../src/lib/state.ts";
import { startAgentRegistry, type AgentRegistry } from "../src/opencode/agent-registry.ts";
import { agentRowLabel, continuationIndicatorText } from "../src/presentation/tui/agent-rows.ts";
import {
  continuationWaitFixture,
  type ContinuationOutcome,
  type ContinuationWaitFixture,
} from "./helpers/continuation-wait-fixture.ts";
import {
  drainMicrotasks,
  FakeAgentRegistryClient,
  FakeEventFeed,
  sdkSession,
  statusEvent,
} from "./helpers/fake-agent-registry-client.ts";

const REPO_DIR = "/tmp/looper-agent-registry-scenarios";

type Scenario = {
  readonly state: LoopState;
  readonly fake: FakeAgentRegistryClient;
  readonly feed: FakeEventFeed;
  readonly registry: AgentRegistry;
  readonly controller: { readonly stop: () => void };
};

const cleanups: (() => void)[] = [];

function startScenario(configure?: (fake: FakeAgentRegistryClient) => void): Scenario {
  const fake = new FakeAgentRegistryClient();
  const feed = new FakeEventFeed();
  fake.queueFeed(feed);
  configure?.(fake);
  const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
  const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });
  const controller = startAgentRegistryController({ state, registry });
  cleanups.push(() => {
    controller.stop();
    registry.stop();
  });
  return { state, fake, feed, registry, controller };
}

async function notifyAndSettle(): Promise<void> {
  await new Promise<void>((resolve) => {
    const unsubscribe = subscribe(() => {
      unsubscribe();
      resolve();
    });
    notify();
  });
  await drainMicrotasks();
}

async function activateNestedScenario(): Promise<Scenario> {
  const scenario = startScenario((fake) => {
    fake.children.set("ses_root", [sdkSession({ id: "ses_child", parentID: "ses_root", createdAt: 10 })]);
    fake.children.set("ses_child", [sdkSession({ id: "ses_grand", parentID: "ses_child", createdAt: 20 })]);
    fake.statuses.ses_child = { type: "busy" };
    fake.statuses.ses_grand = { type: "busy" };
  });
  const step = scenario.state.steps[0];
  if (step === undefined) throw new TypeError("Expected the scenario step");
  step.status = "running";
  step.sessionID = "ses_root";
  await notifyAndSettle();
  return scenario;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  cancelPendingNotify();
});

describe("S1 happy — nested discovery", () => {
  test("projects busy child and grandchild rows in preorder when the controller syncs a running step", async () => {
    // Given
    const scenario = await activateNestedScenario();

    // When
    const agents = scenario.state.steps[0]?.backgroundAgents;

    // Then
    expect(agents?.map(({ sessionID, depth, activity }) => ({ sessionID, depth, activity }))).toEqual([
      { sessionID: "ses_child", depth: 1, activity: "busy" },
      { sessionID: "ses_grand", depth: 2, activity: "busy" },
    ]);
    expect(flattenRows(scenario.state)).toEqual([
      { kind: "step", stepIndex: 0 },
      { kind: "background", stepIndex: 0, sessionID: "ses_child" },
      { kind: "background", stepIndex: 0, sessionID: "ses_grand" },
    ]);
    const grandchild = agents?.[1];
    expect(grandchild === undefined ? "" : agentRowLabel(grandchild, "⠋")).toStartWith("  ↳ ⠋");
  });
});

describe("S2 edge cases", () => {
  test("excludes title children identified by metadata and by agent name", async () => {
    // Given
    const scenario = startScenario((fake) => {
      fake.children.set("ses_root", [
        sdkSession({ id: "ses_metadata_title", parentID: "ses_root", metadata: { purpose: "title" } }),
        sdkSession({ id: "ses_agent_title", parentID: "ses_root", agent: "looper-title" }),
      ]);
    });
    const step = scenario.state.steps[0];
    if (step === undefined) throw new TypeError("Expected the scenario step");
    step.status = "running";
    step.sessionID = "ses_root";

    // When
    await notifyAndSettle();

    // Then
    expect(step.backgroundAgents).toEqual([]);
  });

  test("shows continuation without adding an agent row when no agents exist", () => {
    // Given
    const scenario = startScenario();
    const step = scenario.state.steps[0];
    if (step === undefined) throw new TypeError("Expected the scenario step");

    // When
    setStepContinuation(scenario.state, 0, { reason: "delegated work active", since: 1 });

    // Then
    expect(flattenRows(scenario.state)).toEqual([{ kind: "step", stepIndex: 0 }]);
    expect(continuationIndicatorText(step).length).toBeGreaterThan(0);
  });

  test("retains an idle child and its selection while the parent step is waiting", async () => {
    // Given
    const scenario = await activateNestedScenario();
    const step = scenario.state.steps[0];
    if (step === undefined) throw new TypeError("Expected the scenario step");
    step.status = "waiting";
    selectStepListRow(scenario.state, 1);

    // When
    scenario.feed.push(statusEvent("ses_child", { type: "idle" }));
    await drainMicrotasks();

    // Then
    expect(step.backgroundAgents[0]?.activity).toBe("idle");
    expect(scenario.state.selectedBackgroundSessionID).toBe("ses_child");
  });

  test("prunes agents and clears their selection when the parent step becomes done", async () => {
    // Given
    const scenario = await activateNestedScenario();
    const step = scenario.state.steps[0];
    if (step === undefined) throw new TypeError("Expected the scenario step");
    selectStepListRow(scenario.state, 2);

    // When
    step.status = "done";
    await notifyAndSettle();

    // Then
    expect(step.backgroundAgents).toEqual([]);
    expect(scenario.state.selectedBackgroundSessionID).toBeNull();
  });
});

describe("S3 regressions", () => {
  for (const outcome of ["orphaned", "idle", "resumed"] as const satisfies readonly ContinuationOutcome[]) {
    test(`returns ${outcome} for the corresponding continuation fixture`, async () => {
      // Given
      const fixture: ContinuationWaitFixture = continuationWaitFixture(outcome);
      cleanups.push(fixture.cleanup);

      // When
      const result = await waitForLoopContinuationIdle({
        state: fixture.state,
        client: fixture.client,
        stepIndex: 0,
        repoDir: fixture.repoDir,
        sessionID: fixture.sessionID,
      });

      // Then
      expect(result).toBe(outcome);
    });
  }

  test("fetches nested child messages when its projected row is selected", async () => {
    // Given
    const scenario = await activateNestedScenario();
    selectStepListRow(scenario.state, 2);

    // When
    const streamer = startBackgroundAgentStreamer({ state: scenario.state, client: scenario.fake.client, repoDir: REPO_DIR });
    cleanups.push(streamer.stop);
    await drainMicrotasks();

    // Then
    expect(scenario.fake.messagesCalls).toEqual(["ses_grand"]);
  });

  test("navigates step then child then grandchild without changing flat row order", async () => {
    // Given
    const scenario = await activateNestedScenario();
    selectStepListRow(scenario.state, 0);

    // When
    const traversed = [selectNextStep(scenario.state), selectNextStep(scenario.state)];

    // Then
    expect(traversed).toEqual([
      { kind: "background", stepIndex: 0, sessionID: "ses_child" },
      { kind: "background", stepIndex: 0, sessionID: "ses_grand" },
    ]);
    expect(flattenRows(scenario.state).map((row) => row.kind)).toEqual(["step", "background", "background"]);
  });
});
