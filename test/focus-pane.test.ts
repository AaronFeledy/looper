import { describe, expect, test } from "bun:test";

import { createLoopState, githubPrPanelVisible, setGithubStatus, toggleFocusedPane } from "../src/lib/state.ts";

describe("toggleFocusedPane with github", () => {
  test("cycles steps → github → output when PR panel is visible", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    setGithubStatus(state, {
      kind: "pr",
      pr: {
        number: 1,
        title: "t",
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/o/r/pull/1",
        ciOverall: "none",
        ciPassing: 0,
        ciFailing: 0,
        ciPending: 0,
        ciNeutral: 0,
        ciTotal: 0,
        mergeable: "unknown",
      },
    });
    expect(githubPrPanelVisible(state)).toBe(true);
    expect(state.focusedPane).toBe("steps");
    expect(toggleFocusedPane(state)).toBe("github");
    expect(toggleFocusedPane(state)).toBe("output");
    expect(toggleFocusedPane(state)).toBe("steps");
  });

  test("skips github when no PR", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    expect(toggleFocusedPane(state)).toBe("output");
    expect(toggleFocusedPane(state)).toBe("steps");
  });

  test("leaves github focus when PR disappears", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    setGithubStatus(state, {
      kind: "pr",
      pr: {
        number: 1,
        title: "t",
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/o/r/pull/1",
        ciOverall: "none",
        ciPassing: 0,
        ciFailing: 0,
        ciPending: 0,
        ciNeutral: 0,
        ciTotal: 0,
        mergeable: "unknown",
      },
    });
    toggleFocusedPane(state);
    expect(state.focusedPane).toBe("github");
    setGithubStatus(state, { kind: "no-pr" });
    expect(state.focusedPane).toBe("steps");
  });
});
