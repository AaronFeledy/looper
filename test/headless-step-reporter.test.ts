import { describe, expect, test } from "bun:test";

import { createHeadlessStepReporterHarness } from "../src/engine/headless-step-reporter.ts";
import { runStepReporterContract } from "./helpers/step-reporter-contract.ts";

runStepReporterContract("headless step reporter", () => {
  const harness = createHeadlessStepReporterHarness({ stepNames: ["Build"] });
  return {
    reporter: harness.reporter,
    readRow: (stepIndex) => harness.rows[stepIndex],
    readStepLines: (stepIndex) => harness.stepLines[stepIndex] ?? [],
    readStepEvents: (stepIndex) => harness.stepEvents[stepIndex] ?? [],
    readAgentLines: () => harness.agentLines,
  };
});

describe("headless step reporter buffers", () => {
  test("writes each emitted line once in order across steps", () => {
    // Given
    const written: string[] = [];
    const { reporter } = createHeadlessStepReporterHarness({
      stepNames: ["Build", "Review"],
      write: (line) => written.push(line),
    });

    // When
    reporter.out.line(1, "review-one");
    reporter.out.lines(0, ["build-one", "build-two"]);
    reporter.out.line(1, "review-two");

    // Then
    expect(written).toEqual(["review-one", "build-one", "build-two", "review-two"]);
  });

  test("isolates lines and events by step index", () => {
    // Given
    const harness = createHeadlessStepReporterHarness({ stepNames: ["Build", "Review"] });

    // When
    harness.reporter.out.line(0, "build");
    harness.reporter.out.line(1, "[looper] review");
    harness.reporter.out.event(0, { kind: "assistant.started" });

    // Then
    expect(harness.stepLines).toEqual([["build"], ["[looper] review"]]);
    expect(harness.stepEvents).toEqual([[{ kind: "assistant.started" }], [{ kind: "looper.log", message: "review" }]]);
  });

  test("ignores out-of-range calls without throwing", () => {
    // Given
    const { reporter } = createHeadlessStepReporterHarness({ stepNames: ["Build"] });

    // When
    const act = (): void => {
      reporter.out.line(99, "line");
      reporter.out.lines(99, ["one", "two"]);
      reporter.out.event(99, { kind: "assistant.started" });
      reporter.steps.begin(99);
      reporter.steps.markWaiting(99);
      reporter.steps.markWaitingForBackground(99);
      reporter.steps.finalize(99, "done");
      reporter.steps.setSessionID(99, "session");
      reporter.steps.setPromptText(99, "prompt");
      reporter.steps.setLooperMessageIDs(99, ["message"]);
      reporter.steps.setContinuation(99, { reason: "background", since: 1 });
      reporter.steps.clearStatusMessageIf(99, "waiting");
      reporter.notify();
    };

    // Then
    expect(act).not.toThrow();
  });
});
