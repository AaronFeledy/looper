import { afterEach, describe, expect, test } from "bun:test";

import {
  FOLLOW_INDICATOR,
  FOLLOW_INDICATOR_ACTIVE_BRIGHT,
  FOLLOW_INDICATOR_ACTIVE_DIM,
  FOLLOW_INDICATOR_INACTIVE,
  followBottomTitle,
  followIndicatorColor,
  isAtScrollBottom,
  pinAfterUserScroll,
} from "../src/lib/output-follow.ts";
import {
  beginStepRun,
  cancelPendingNotify,
  createBackgroundAgent,
  createLoopState,
  selectNextStep,
  selectPreviousStep,
  selectStepListRow,
  syncSelectionToActiveStep,
} from "../src/lib/state.ts";

afterEach(() => {
  cancelPendingNotify();
});

describe("pinAfterUserScroll", () => {
  test("unpins one row above the bottom", () => {
    expect(pinAfterUserScroll(10, 10)).toBe(true);
    expect(pinAfterUserScroll(9, 10)).toBe(false);
    expect(pinAfterUserScroll(8, 10)).toBe(false);
  });

  test("treats empty or non-scrollable content as pinned", () => {
    expect(pinAfterUserScroll(0, 0)).toBe(true);
    expect(isAtScrollBottom(0, 0)).toBe(true);
  });
});

describe("followBottomTitle", () => {
  test("always shows the down arrow so the control stays visible", () => {
    expect(followBottomTitle(true)).toBe(FOLLOW_INDICATOR);
    expect(followBottomTitle(false)).toBe(FOLLOW_INDICATOR);
  });
});

describe("followIndicatorColor", () => {
  test("grays out when auto-scroll is off", () => {
    expect(followIndicatorColor(false)).toBe(FOLLOW_INDICATOR_INACTIVE);
    expect(followIndicatorColor(false, 1200)).toBe(FOLLOW_INDICATOR_INACTIVE);
  });

  test("pulses between dim and bright while auto-scroll is on", () => {
    expect(followIndicatorColor(true, 0)).toBe(FOLLOW_INDICATOR_ACTIVE_DIM);
    expect(followIndicatorColor(true, 1200)).toBe(FOLLOW_INDICATOR_ACTIVE_BRIGHT);
    expect(followIndicatorColor(true, 2400)).toBe(FOLLOW_INDICATOR_ACTIVE_DIM);
  });
});

describe("rejoin live follow on active step select", () => {
  test("selecting the running step clears manual selection and re-pins", () => {
    const state = createLoopState({ maxIterations: 3, stepNames: ["build", "review"] });
    beginStepRun(state, 1);
    expect(state.manualStepSelection).toBe(false);
    expect(state.selectedStepIndex).toBe(1);

    selectStepListRow(state, 0);
    expect(state.selectedStepIndex).toBe(0);
    expect(state.manualStepSelection).toBe(true);
    state.steps[1]!.outputPinnedToBottom = false;
    state.steps[1]!.outputScrollTop = 3;

    selectStepListRow(state, 1);
    expect(state.selectedStepIndex).toBe(1);
    expect(state.manualStepSelection).toBe(false);
    expect(state.steps[1]!.outputPinnedToBottom).toBe(true);
  });

  test("after rejoining live, beginStepRun advances selection to the next active step", () => {
    const state = createLoopState({ maxIterations: 3, stepNames: ["build", "review", "ship"] });
    beginStepRun(state, 0);
    selectNextStep(state);
    expect(state.selectedStepIndex).toBe(1);
    expect(state.manualStepSelection).toBe(true);

    selectPreviousStep(state);
    expect(state.selectedStepIndex).toBe(0);
    expect(state.manualStepSelection).toBe(false);

    state.activeStepIndex = null;
    beginStepRun(state, 1);
    expect(state.selectedStepIndex).toBe(1);
    expect(state.manualStepSelection).toBe(false);
  });

  test("selecting a background agent of the active step stays manual", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    beginStepRun(state, 0);
    state.steps[0]!.backgroundAgents = [createBackgroundAgent("ses_bg", 1)];

    selectNextStep(state);
    expect(state.selectedBackgroundSessionID).toBe("ses_bg");
    expect(state.manualStepSelection).toBe(true);

    syncSelectionToActiveStep(state);
    expect(state.selectedBackgroundSessionID).toBe("ses_bg");
    expect(state.manualStepSelection).toBe(true);
  });
});
