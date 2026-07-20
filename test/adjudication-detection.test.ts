import { describe, expect, test } from "bun:test";

import { detectOscillation, diffPasses } from "../src/lib/adjudication-detection.ts";
import type { StoryTransitionRecord } from "../src/lib/adjudication-detection.ts";

type RecordInput = Omit<StoryTransitionRecord, "stepName" | "at"> & {
  readonly stepName?: string;
  readonly at?: string;
};

function record(input: RecordInput): StoryTransitionRecord {
  return {
    storyId: input.storyId,
    from: input.from,
    to: input.to,
    iteration: input.iteration,
    stepName: input.stepName ?? "review",
    at: input.at ?? `2026-07-18T00:00:0${input.iteration}.000Z`,
  };
}

describe("detectOscillation", () => {
  const twoFlips = [
    record({ storyId: "story-a", from: true, to: false, iteration: 1 }),
    record({ storyId: "story-a", from: false, to: true, iteration: 2 }),
    record({ storyId: "story-a", from: true, to: false, iteration: 3 }),
  ];

  test("does not fire when the qualifying count is one below the threshold", () => {
    // Given two true-to-false transitions.
    // When the threshold is three.
    const verdict = detectOscillation(twoFlips, 3);

    // Then the detector remains inactive.
    expect(verdict).toEqual({ oscillating: false });
  });

  test("fires when the qualifying count reaches the threshold", () => {
    // Given two true-to-false transitions with an intervening recovery.
    // When the threshold is two.
    const verdict = detectOscillation(twoFlips, 2);

    // Then every transition for the qualifying story is returned as its trail.
    expect(verdict).toEqual({ oscillating: true, storyId: "story-a", trail: twoFlips });
  });

  test("does not count false-to-true transitions toward firing", () => {
    const history = [
      record({ storyId: "story-a", from: false, to: true, iteration: 1 }),
      record({ storyId: "story-a", from: false, to: true, iteration: 2 }),
    ];

    const verdict = detectOscillation(history, 1);

    expect(verdict).toEqual({ oscillating: false });
  });

  test("selects the story with the highest qualifying transition count", () => {
    const storyAFirst = record({ storyId: "story-a", from: true, to: false, iteration: 1 });
    const storyBFirst = record({ storyId: "story-b", from: true, to: false, iteration: 2 });
    const storyBRecovery = record({ storyId: "story-b", from: false, to: true, iteration: 3 });
    const storyBSecond = record({ storyId: "story-b", from: true, to: false, iteration: 4 });
    const history = [storyAFirst, storyBFirst, storyBRecovery, storyBSecond];

    const verdict = detectOscillation(history, 1);

    expect(verdict).toEqual({
      oscillating: true,
      storyId: "story-b",
      trail: [storyBFirst, storyBRecovery, storyBSecond],
    });
  });

  test("breaks qualifying-count ties by first story encountered", () => {
    const storyB = record({ storyId: "story-b", from: true, to: false, iteration: 1 });
    const storyA = record({ storyId: "story-a", from: true, to: false, iteration: 2 });

    const verdict = detectOscillation([storyB, storyA], 1);

    expect(verdict).toEqual({ oscillating: true, storyId: "story-b", trail: [storyB] });
  });

  test("returns a non-oscillating verdict for empty history", () => {
    expect(detectOscillation([], 1)).toEqual({ oscillating: false });
  });

  test("treats zero and negative thresholds as disabled", () => {
    const history = [record({ storyId: "story-a", from: true, to: false, iteration: 1 })];

    expect(detectOscillation(history, 0)).toEqual({ oscillating: false });
    expect(detectOscillation(history, -1)).toEqual({ oscillating: false });
  });
});

describe("diffPasses", () => {
  test("emits only changed stories present in both maps", () => {
    const before = { stable: true, changed: true, removed: false };
    const after = { stable: true, changed: false, added: true };

    const transitions = diffPasses(before, after);

    expect(transitions).toEqual([{ storyId: "changed", from: true, to: false }]);
  });

  test("returns no transitions for empty maps", () => {
    expect(diffPasses({}, {})).toEqual([]);
  });
});
