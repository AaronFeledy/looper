import { describe, expect, test } from "bun:test";

import {
  createLoopState,
  enterHistoryView,
  exitHistoryView,
  historyMoveIteration,
  historyMoveStep,
  selectStepListRow,
  selectedHistoryStep,
  setFocusedPane,
  setHistoryViewOutput,
  snapshotIterationToHistory,
  type LoopState,
} from "../src/lib/state.ts";

function seedIteration(state: LoopState, iteration: number, sessions: (string | undefined)[]): void {
  state.iteration = iteration;
  state.branch = `branch-${iteration}`;
  state.steps = sessions.map((sessionID, index) => ({
    name: `step-${index}`,
    status: "done" as const,
    ...(sessionID !== undefined ? { sessionID } : {}),
    outputLines: [],
    outputLineTimes: [],
    outputScrollTop: 0,
    outputPinnedToBottom: true,
    backgroundAgents: [],
  }));
  snapshotIterationToHistory(state);
}

describe("iteration history capture", () => {
  test("snapshot skips iteration 0 / empty steps and records real iterations", () => {
    const state = createLoopState({ maxIterations: 10, stepNames: ["a"] });
    snapshotIterationToHistory(state);
    expect(state.history).toHaveLength(0);

    seedIteration(state, 1, ["ses_a", "ses_b"]);
    seedIteration(state, 2, ["ses_c", undefined]);
    expect(state.history).toHaveLength(2);
    expect(state.history[0]!.iteration).toBe(1);
    expect(state.history[0]!.steps[0]!.sessionID).toBe("ses_a");
    expect(state.history[1]!.steps[1]!.sessionID).toBeUndefined();
  });

  test("snapshot copies prompt ownership metadata without retaining mutable arrays", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step = state.steps[0];
    expect(step).toBeDefined();
    if (step === undefined) return;
    state.iteration = 1;
    step.status = "done";
    step.promptText = "owned prompt";
    step.looperMessageIDs = ["msg_owned"];

    snapshotIterationToHistory(state);
    step.promptText = "mutated prompt";
    step.looperMessageIDs.push("msg_later");

    expect(state.history[0]?.steps[0]?.promptText).toBe("owned prompt");
    expect(state.history[0]?.steps[0]?.looperMessageIDs).toEqual(["msg_owned"]);
  });
});

describe("history view navigation", () => {
  test("enter selects newest iteration; iteration/step moves are clamped", () => {
    const state = createLoopState({ maxIterations: 10, stepNames: ["a"] });
    seedIteration(state, 1, ["ses_a1", "ses_a2"]);
    seedIteration(state, 2, ["ses_b1", "ses_b2"]);

    expect(enterHistoryView(state)).toBe(true);
    expect(state.historyView!.entryIndex).toBe(1);
    expect(state.historyView!.stepIndex).toBe(0);
    expect(selectedHistoryStep(state)!.step.sessionID).toBe("ses_b1");

    historyMoveStep(state, 1);
    expect(selectedHistoryStep(state)!.step.sessionID).toBe("ses_b2");
    historyMoveStep(state, 5);
    expect(state.historyView!.stepIndex).toBe(1);

    historyMoveIteration(state, -1);
    expect(state.historyView!.entryIndex).toBe(0);
    expect(state.historyView!.stepIndex).toBe(0);
    expect(selectedHistoryStep(state)!.step.sessionID).toBe("ses_a1");

    historyMoveIteration(state, -5);
    expect(state.historyView!.entryIndex).toBe(0);

    exitHistoryView(state);
    expect(state.historyView).toBeNull();
  });

  test("enter on empty history is a no-op", () => {
    const state = createLoopState({ maxIterations: 10, stepNames: ["a"] });
    expect(enterHistoryView(state)).toBe(false);
    expect(state.historyView).toBeNull();
  });

  test("output is only applied to the matching selection key (stale-guard)", () => {
    const state = createLoopState({ maxIterations: 10, stepNames: ["a"] });
    seedIteration(state, 1, ["ses_a1", "ses_a2"]);
    enterHistoryView(state);

    setHistoryViewOutput(state, "0:0:ses_a1", ["hello"], [1]);
    expect(state.historyView!.lines).toEqual(["hello"]);
    expect(state.historyView!.status).toBe("ready");

    setHistoryViewOutput(state, "0:1:ses_a2", ["stale"], [1]);
    expect(state.historyView!.lines).toEqual(["hello"]);
  });

  test("selectStepListRow jumps to an absolute history step and focuses steps", () => {
    const state = createLoopState({ maxIterations: 10, stepNames: ["a"] });
    seedIteration(state, 1, ["ses_a1", "ses_a2", "ses_a3"]);
    enterHistoryView(state);
    setFocusedPane(state, "output");

    selectStepListRow(state, 2);
    expect(state.focusedPane).toBe("steps");
    expect(state.historyView!.stepIndex).toBe(2);
    expect(selectedHistoryStep(state)!.step.sessionID).toBe("ses_a3");

    selectStepListRow(state, 99);
    expect(state.historyView!.stepIndex).toBe(2);
  });
});
