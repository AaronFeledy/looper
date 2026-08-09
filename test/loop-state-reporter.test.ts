import { describe, expect, test } from "bun:test";

import { createLoopStateStepReporter } from "../src/lib/loop-state-reporter.ts";
import { createLoopState } from "../src/lib/state.ts";
import { runStepReporterContract } from "./helpers/step-reporter-contract.ts";

function createFixture() {
  const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
  return {
    reporter: createLoopStateStepReporter(state),
    readRow: (stepIndex: number) => state.steps[stepIndex],
    readStepLines: (stepIndex: number) => state.steps[stepIndex]?.outputLines ?? [],
    readStepEvents: (stepIndex: number) => state.steps[stepIndex]?.outputEvents ?? [],
    readAgentLines: () => state.agentLines,
  };
}

runStepReporterContract("LoopState-backed step reporter", createFixture);

describe("LoopState reporter delegation", () => {
  test("reads the reassigned pending-request array after clearing", () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const reporter = createLoopStateStepReporter(state);
    reporter.requests.enqueuePermission({
      requestID: "permission-1",
      sessionID: "session-1",
      permission: "edit",
      patterns: [],
      generation: 1,
    });
    const before = reporter.requests.list();

    // When
    reporter.requests.clearAll();

    // Then
    expect(before).toHaveLength(1);
    expect(reporter.requests.list()).toEqual([]);
    expect(reporter.requests.list()).not.toBe(before);
  });

  test("records a prefixed looper line in both step buffers", () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const reporter = createLoopStateStepReporter(state);

    // When
    reporter.out.line(0, "[looper] hi", 10);

    // Then
    expect(state.steps[0]?.outputLines).toEqual(["[looper] hi"]);
    expect(state.steps[0]?.outputEvents).toEqual([{ kind: "looper.log", message: "hi" }]);
  });

  test("clears the active step when waiting for background work", () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const reporter = createLoopStateStepReporter(state);
    reporter.steps.begin(0);

    // When
    reporter.steps.markWaitingForBackground(0);

    // Then
    expect(state.activeStepIndex).toBeNull();
  });

  test("preserves the active step during an ordinary wait", () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const reporter = createLoopStateStepReporter(state);
    reporter.steps.begin(0);

    // When
    reporter.steps.markWaiting(0);

    // Then
    expect(state.activeStepIndex).toBe(0);
  });

  test("preserves a status message that differs from the expected value", () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const reporter = createLoopStateStepReporter(state);
    reporter.steps.begin(0, { statusMessage: "reattaching" });

    // When
    reporter.steps.clearStatusMessageIf(0, "other");

    // Then
    expect(state.steps[0]?.statusMessage).toBe("reattaching");
  });

  test("clears a status message that exactly matches the expected value", () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const reporter = createLoopStateStepReporter(state);
    reporter.steps.begin(0, { statusMessage: "reattaching" });

    // When
    reporter.steps.clearStatusMessageIf(0, "reattaching");

    // Then
    expect(state.steps[0]?.statusMessage).toBeUndefined();
  });
});
