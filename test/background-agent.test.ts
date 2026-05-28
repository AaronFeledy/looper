import { describe, expect, test } from "bun:test";

import { renderSessionMessages } from "../src/lib/event-consumer.ts";
import {
  clearBackgroundAgentBuffer,
  createLoopState,
  flattenRows,
  pushBackgroundAgentLines,
  selectNextStep,
  selectPreviousStep,
  syncStepBackgroundAgents,
} from "../src/lib/state.ts";

function state(stepNames: string[]) {
  return createLoopState({ maxIterations: 1, stepNames });
}

describe("flattenRows", () => {
  test("intersperses background sub-rows under their parent step", () => {
    const s = state(["build", "review"]);
    syncStepBackgroundAgents(s, 0, [
      { sessionID: "ses_a", startedAt: 1, agent: "explore" },
      { sessionID: "ses_b", startedAt: 2 },
    ]);
    syncStepBackgroundAgents(s, 1, [{ sessionID: "ses_c", startedAt: 3 }]);

    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      { kind: "background", stepIndex: 0, sessionID: "ses_a" },
      { kind: "background", stepIndex: 0, sessionID: "ses_b" },
      { kind: "step", stepIndex: 1 },
      { kind: "background", stepIndex: 1, sessionID: "ses_c" },
    ]);
  });
});

describe("syncStepBackgroundAgents", () => {
  test("preserves existing buffers and clears selection for removed agents", () => {
    const s = state(["build"]);
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1 }]);
    pushBackgroundAgentLines(s, 0, "ses_a", ["line one", "line two"]);
    s.selectedStepIndex = 0;
    s.selectedBackgroundSessionID = "ses_a";
    s.manualStepSelection = true;

    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1, agent: "explore" }]);
    expect(s.steps[0]?.backgroundAgents[0]?.outputLines).toEqual(["line one", "line two"]);
    expect(s.steps[0]?.backgroundAgents[0]?.agent).toBe("explore");

    syncStepBackgroundAgents(s, 0, []);
    expect(s.steps[0]?.backgroundAgents).toEqual([]);
    expect(s.selectedBackgroundSessionID).toBeNull();
  });
});

describe("selectNext/Previous traversal", () => {
  test("walks step-then-bg-then-next-step", () => {
    const s = state(["build", "review"]);
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1 }]);

    selectNextStep(s);
    expect(s.selectedStepIndex).toBe(0);
    expect(s.selectedBackgroundSessionID).toBeNull();

    selectNextStep(s);
    expect(s.selectedStepIndex).toBe(0);
    expect(s.selectedBackgroundSessionID).toBe("ses_a");

    selectNextStep(s);
    expect(s.selectedStepIndex).toBe(1);
    expect(s.selectedBackgroundSessionID).toBeNull();

    selectPreviousStep(s);
    expect(s.selectedStepIndex).toBe(0);
    expect(s.selectedBackgroundSessionID).toBe("ses_a");
  });
});

describe("clearBackgroundAgentBuffer", () => {
  test("drops accumulated lines but leaves the agent itself", () => {
    const s = state(["build"]);
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1 }]);
    pushBackgroundAgentLines(s, 0, "ses_a", ["x", "y"]);
    clearBackgroundAgentBuffer(s, 0, "ses_a");

    const agent = s.steps[0]?.backgroundAgents[0];
    expect(agent?.outputLines).toEqual([]);
    expect(agent?.outputLineTimes).toEqual([]);
    expect(agent?.sessionID).toBe("ses_a");
  });
});

describe("renderSessionMessages", () => {
  test("emits assistant text lines and skips user messages", () => {
    const lines = renderSessionMessages([
      {
        info: { id: "msg_u", role: "user" } as never,
        parts: [{ id: "p1", type: "text", text: "ignored user prompt" } as never],
      },
      {
        info: { id: "msg_a", role: "assistant" } as never,
        parts: [{ id: "p2", type: "text", text: "hello\nworld\n", time: { end: 1 } } as never],
      },
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("hello");
    expect(joined).toContain("world");
    expect(joined).not.toContain("ignored user prompt");
  });
});
