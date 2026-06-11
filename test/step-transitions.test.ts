import { describe, expect, test } from "bun:test";

import {
  beginStepRun,
  createLoopState,
  failStepRow,
  finalizeStepRow,
  markStepWaiting,
  resetStepRowToPending,
  syncStepBackgroundAgents,
  type LoopState,
} from "../src/lib/state.ts";

function state(stepNames: string[]): LoopState {
  return createLoopState({ maxIterations: 1, stepNames });
}

describe("beginStepRun", () => {
  test("marks the step running, active, and selected", () => {
    const s = state(["build", "review"]);
    beginStepRun(s, 1);
    expect(s.steps[1]!.status).toBe("running");
    expect(s.activeStepIndex).toBe(1);
    expect(s.selectedStepIndex).toBe(1);
    expect(s.steps[1]!.startedAt).toBeGreaterThan(0);
    expect(s.steps[1]!.finishedAt).toBeUndefined();
  });

  test("preserves the original startedAt across a reattach of the same row", () => {
    const s = state(["build"]);
    beginStepRun(s, 0);
    const first = s.steps[0]!.startedAt;
    s.steps[0]!.finishedAt = 123;
    beginStepRun(s, 0, { statusMessage: "reattaching" });
    expect(s.steps[0]!.startedAt).toBe(first);
    expect(s.steps[0]!.statusMessage).toBe("reattaching");
    expect(s.steps[0]!.finishedAt).toBeUndefined();
  });
});

describe("markStepWaiting", () => {
  test("sets waiting without touching activeStepIndex", () => {
    const s = state(["build"]);
    beginStepRun(s, 0);
    markStepWaiting(s, 0);
    expect(s.steps[0]!.status).toBe("waiting");
    expect(s.steps[0]!.statusMessage).toBeUndefined();
    expect(s.activeStepIndex).toBe(0);
  });
});

describe("resetStepRowToPending", () => {
  test("resets to pending, clears finishedAt, preserves startedAt", () => {
    const s = state(["build"]);
    beginStepRun(s, 0);
    const started = s.steps[0]!.startedAt;
    finalizeStepRow(s, 0, "failed");
    resetStepRowToPending(s, 0, { statusMessage: "retry in 5s" });
    expect(s.steps[0]!.status).toBe("pending");
    expect(s.steps[0]!.statusMessage).toBe("retry in 5s");
    expect(s.steps[0]!.finishedAt).toBeUndefined();
    expect(s.steps[0]!.startedAt).toBe(started);
  });
});

describe("finalizeStepRow", () => {
  test("stamps finishedAt for every terminal including skipped", () => {
    for (const status of ["done", "failed", "skipped"] as const) {
      const s = state(["build"]);
      beginStepRun(s, 0);
      finalizeStepRow(s, 0, status);
      expect(s.steps[0]!.status).toBe(status);
      expect(s.steps[0]!.finishedAt).toBeGreaterThan(0);
      expect(s.activeStepIndex).toBeNull();
    }
  });

  test("'restart' resets the row to pending and clears finishedAt", () => {
    const s = state(["build"]);
    beginStepRun(s, 0);
    finalizeStepRow(s, 0, "restart");
    expect(s.steps[0]!.status).toBe("pending");
    expect(s.steps[0]!.finishedAt).toBeUndefined();
    expect(s.activeStepIndex).toBeNull();
  });

  test("clears background-agent rows and their selection", () => {
    const s = state(["build"]);
    beginStepRun(s, 0);
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1 }]);
    s.selectedBackgroundSessionID = "ses_a";
    finalizeStepRow(s, 0, "done");
    expect(s.steps[0]!.backgroundAgents).toHaveLength(0);
    expect(s.selectedBackgroundSessionID).toBeNull();
  });
});

describe("failStepRow", () => {
  test("clears activeStepIndex but PRESERVES background-agent rows", () => {
    const s = state(["build"]);
    beginStepRun(s, 0);
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1 }]);
    failStepRow(s, 0, "failed");
    expect(s.steps[0]!.status).toBe("failed");
    expect(s.steps[0]!.finishedAt).toBeGreaterThan(0);
    expect(s.activeStepIndex).toBeNull();
    expect(s.steps[0]!.backgroundAgents).toHaveLength(1);
  });

  test("supports a skipped terminal", () => {
    const s = state(["build"]);
    beginStepRun(s, 0);
    failStepRow(s, 0, "skipped");
    expect(s.steps[0]!.status).toBe("skipped");
  });
});
