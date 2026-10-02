import { describe, expect, test } from "bun:test";

import { createLoopState, nextFocusedPane, toggleFocusedPane } from "../src/lib/state.ts";

describe("toggleFocusedPane", () => {
  test("cycles steps → output → steps", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    expect(state.focusedPane).toBe("steps");
    expect(nextFocusedPane(state)).toBe("output");
    expect(toggleFocusedPane(state)).toBe("output");
    expect(toggleFocusedPane(state)).toBe("steps");
  });
});
