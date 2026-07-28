import { afterEach, describe, expect, test } from "bun:test";

import { setStepContinuation, syncStepAgentTree } from "../src/lib/agent-tree-state.ts";
import {
  cancelPendingNotify,
  createLoopState,
  pushBackgroundAgentLines,
  subscribe,
  type LoopState,
  type LoopStep,
} from "../src/lib/state.ts";

function createState(): LoopState {
  return createLoopState({ maxIterations: 1, stepNames: ["build"] });
}

function firstStep(state: LoopState): LoopStep {
  const step = state.steps[0];
  if (step === undefined) throw new TypeError("Expected the build step fixture");
  return step;
}

afterEach(() => {
  cancelPendingNotify();
});

describe("syncStepAgentTree", () => {
  test("preserves nested depth and projected metadata", () => {
    // Given
    const state = createState();

    // When
    syncStepAgentTree(state, 0, [
      {
        sessionID: "ses_parent",
        parentSessionID: "ses_step",
        depth: 1,
        agent: "explore",
        title: "Parent",
        activity: "busy",
        startedAt: 10,
      },
      {
        sessionID: "ses_child",
        parentSessionID: "ses_parent",
        depth: 2,
        agent: "librarian",
        title: "Child",
        activity: "idle",
        startedAt: 20,
      },
    ]);

    // Then
    expect(firstStep(state).backgroundAgents).toMatchObject([
      { sessionID: "ses_parent", parentSessionID: "ses_step", depth: 1, activity: "busy" },
      { sessionID: "ses_child", parentSessionID: "ses_parent", depth: 2, activity: "idle" },
    ]);
  });

  test("preserves output buffers and scroll state across syncs", () => {
    // Given
    const state = createState();
    syncStepAgentTree(state, 0, [
      { sessionID: "ses_child", parentSessionID: "ses_step", depth: 1, activity: "busy", startedAt: 10 },
    ]);
    pushBackgroundAgentLines(state, 0, "ses_child", ["working"], [11]);
    const existing = firstStep(state).backgroundAgents[0];
    if (existing === undefined) throw new TypeError("Expected the child agent fixture");
    existing.outputEvents = [{ kind: "looper.log", message: "event" }];
    existing.outputEventTimes = [12];
    existing.outputScrollTop = 4;
    existing.outputPinnedToBottom = false;

    // When
    syncStepAgentTree(state, 0, [
      {
        sessionID: "ses_child",
        parentSessionID: "ses_step",
        depth: 2,
        agent: "explore",
        title: "Updated",
        activity: "idle",
        startedAt: 10,
      },
    ]);

    // Then
    expect(firstStep(state).backgroundAgents[0]).toMatchObject({
      outputLines: ["working"],
      outputLineTimes: [11],
      outputEvents: [{ kind: "looper.log", message: "event" }],
      outputEventTimes: [12],
      outputScrollTop: 4,
      outputPinnedToBottom: false,
    });
  });

  test("retains an absent idle child while the step is waiting", () => {
    // Given
    const state = createState();
    const step = firstStep(state);
    step.status = "waiting";
    syncStepAgentTree(state, 0, [
      { sessionID: "ses_child", parentSessionID: "ses_step", depth: 1, activity: "idle", startedAt: 10 },
    ]);

    // When
    syncStepAgentTree(state, 0, []);

    // Then
    expect(step.backgroundAgents).toMatchObject([{ sessionID: "ses_child", activity: "idle" }]);
  });

  test("forces a retained absent busy child to idle so it does not spin forever", () => {
    // Given
    const state = createState();
    const step = firstStep(state);
    step.status = "waiting";
    syncStepAgentTree(state, 0, [
      { sessionID: "ses_child", parentSessionID: "ses_step", depth: 1, activity: "busy", startedAt: 10 },
    ]);
    expect(step.backgroundAgents[0]?.activity).toBe("busy");
    expect(step.backgroundAgents[0]?.finishedAt).toBeUndefined();

    // When — registry no longer projects the child (deleted / dropped)
    syncStepAgentTree(state, 0, []);

    // Then
    expect(step.backgroundAgents).toHaveLength(1);
    expect(step.backgroundAgents[0]).toMatchObject({
      sessionID: "ses_child",
      activity: "idle",
    });
    expect(step.backgroundAgents[0]?.finishedAt).toBeTypeOf("number");
  });

  test("appends retained agents after incoming preorder in stable order", () => {
    // Given
    const state = createState();
    const step = firstStep(state);
    step.status = "running";
    syncStepAgentTree(state, 0, [
      { sessionID: "ses_old_a", parentSessionID: "ses_step", depth: 1, activity: "idle", startedAt: 10 },
      { sessionID: "ses_old_b", parentSessionID: "ses_step", depth: 1, activity: "idle", startedAt: 20 },
    ]);

    // When
    syncStepAgentTree(state, 0, [
      { sessionID: "ses_new", parentSessionID: "ses_step", depth: 1, activity: "busy", startedAt: 30 },
    ]);

    // Then
    expect(step.backgroundAgents.map(({ sessionID }) => sessionID)).toEqual(["ses_new", "ses_old_a", "ses_old_b"]);
  });

  test("prunes absent agents when the step is done", () => {
    // Given
    const state = createState();
    const step = firstStep(state);
    syncStepAgentTree(state, 0, [
      { sessionID: "ses_child", parentSessionID: "ses_step", depth: 1, activity: "idle", startedAt: 10 },
    ]);
    step.status = "done";

    // When
    syncStepAgentTree(state, 0, []);

    // Then
    expect(step.backgroundAgents).toEqual([]);
  });

  test("preserves selection when the selected agent is retained", () => {
    // Given
    const state = createState();
    firstStep(state).status = "waiting";
    syncStepAgentTree(state, 0, [
      { sessionID: "ses_child", parentSessionID: "ses_step", depth: 1, activity: "idle", startedAt: 10 },
    ]);
    state.selectedStepIndex = 0;
    state.selectedBackgroundSessionID = "ses_child";

    // When
    syncStepAgentTree(state, 0, []);

    // Then
    expect(state.selectedBackgroundSessionID).toBe("ses_child");
  });

  test("clears selection when the selected agent is pruned", () => {
    // Given
    const state = createState();
    firstStep(state).status = "done";
    syncStepAgentTree(state, 0, [
      { sessionID: "ses_child", parentSessionID: "ses_step", depth: 1, activity: "idle", startedAt: 10 },
    ]);
    state.selectedStepIndex = 0;
    state.selectedBackgroundSessionID = "ses_child";

    // When
    syncStepAgentTree(state, 0, []);

    // Then
    expect(state.selectedBackgroundSessionID).toBeNull();
  });

  test("does not notify for an unchanged sync", async () => {
    // Given
    const state = createState();
    const projected = [
      { sessionID: "ses_child", parentSessionID: "ses_step", depth: 1, activity: "busy" as const, startedAt: 10 },
    ];
    syncStepAgentTree(state, 0, projected);
    cancelPendingNotify();
    let notifications = 0;
    const unsubscribe = subscribe(() => {
      notifications += 1;
    });

    // When
    syncStepAgentTree(state, 0, projected);
    await Bun.sleep(50);
    unsubscribe();

    // Then
    expect(notifications).toBe(0);
  });
});

describe("setStepContinuation", () => {
  test("sets continuation state", () => {
    // Given
    const state = createState();

    // When
    setStepContinuation(state, 0, { reason: "background work", since: 42 });

    // Then
    expect(firstStep(state).continuation).toEqual({ reason: "background work", since: 42 });
  });

  test("deletes continuation state", () => {
    // Given
    const state = createState();
    firstStep(state).continuation = { reason: "background work", since: 42 };

    // When
    setStepContinuation(state, 0, null);

    // Then
    expect(firstStep(state).continuation).toBeUndefined();
  });
});
