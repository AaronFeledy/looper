import { describe, expect, test } from "bun:test";

import { detectOscillation, diffPhases } from "../src/lib/adjudication-detection.ts";
import type { StoryTransitionRecord } from "../src/lib/adjudication-detection.ts";

type RecordInput = Omit<StoryTransitionRecord, "stepName" | "at" | "source"> & {
  readonly stepName?: string;
  readonly at?: string;
  readonly source?: StoryTransitionRecord["source"];
};

function record(input: RecordInput): StoryTransitionRecord {
  return {
    storyId: input.storyId,
    from: input.from,
    to: input.to,
    iteration: input.iteration,
    stepName: input.stepName ?? "review",
    at: input.at ?? `2026-07-18T00:00:0${input.iteration}.000Z`,
    source: input.source ?? "signal",
  };
}

describe("detectOscillation", () => {
  const twoDemotions = [
    record({ storyId: "story-a", from: "reviewed", to: "building", iteration: 1 }),
    record({ storyId: "story-a", from: "building", to: "reviewed", iteration: 2 }),
    record({ storyId: "story-a", from: "reviewed", to: "building", iteration: 3 }),
  ];

  test("does not fire when the qualifying count is one below the threshold", () => {
    // Given two signal demotions.
    // When the threshold is three.
    const verdict = detectOscillation(twoDemotions, 3);

    // Then the detector remains inactive.
    expect(verdict).toEqual({ oscillating: false });
  });

  test("fires when the qualifying demotion count reaches the threshold", () => {
    // Given two signal demotions with an intervening recovery.
    // When the threshold is two.
    const verdict = detectOscillation(twoDemotions, 2);

    // Then every transition for the qualifying story is returned as its trail.
    expect(verdict).toEqual({ oscillating: true, storyId: "story-a", trail: twoDemotions });
  });

  test("does not count promotions toward firing", () => {
    const history = [
      record({ storyId: "story-a", from: "building", to: "implemented", iteration: 1 }),
      record({ storyId: "story-a", from: "implemented", to: "reviewed", iteration: 2 }),
    ];

    const verdict = detectOscillation(history, 1);

    expect(verdict).toEqual({ oscillating: false });
  });

  test("does not count engine-sourced demotions toward firing", () => {
    const history = [
      record({ storyId: "story-a", from: "reviewed", to: "building", iteration: 1, source: "engine" }),
      record({ storyId: "story-a", from: "reviewed", to: "building", iteration: 2, source: "engine" }),
    ];

    expect(detectOscillation(history, 1)).toEqual({ oscillating: false });
  });

  test("selects the story with the highest qualifying demotion count", () => {
    const storyAFirst = record({ storyId: "story-a", from: "reviewed", to: "building", iteration: 1 });
    const storyBFirst = record({ storyId: "story-b", from: "verified", to: "implemented", iteration: 2 });
    const storyBRecovery = record({ storyId: "story-b", from: "implemented", to: "verified", iteration: 3 });
    const storyBSecond = record({ storyId: "story-b", from: "verified", to: "building", iteration: 4 });
    const history = [storyAFirst, storyBFirst, storyBRecovery, storyBSecond];

    const verdict = detectOscillation(history, 1);

    expect(verdict).toEqual({
      oscillating: true,
      storyId: "story-b",
      trail: [storyBFirst, storyBRecovery, storyBSecond],
    });
  });

  test("breaks qualifying-count ties by first story encountered", () => {
    const storyB = record({ storyId: "story-b", from: "reviewed", to: "building", iteration: 1 });
    const storyA = record({ storyId: "story-a", from: "reviewed", to: "building", iteration: 2 });

    const verdict = detectOscillation([storyB, storyA], 1);

    expect(verdict).toEqual({ oscillating: true, storyId: "story-b", trail: [storyB] });
  });

  test("returns a non-oscillating verdict for empty history", () => {
    expect(detectOscillation([], 1)).toEqual({ oscillating: false });
  });

  test("treats zero and negative thresholds as disabled", () => {
    const history = [record({ storyId: "story-a", from: "reviewed", to: "building", iteration: 1 })];

    expect(detectOscillation(history, 0)).toEqual({ oscillating: false });
    expect(detectOscillation(history, -1)).toEqual({ oscillating: false });
  });
});

describe("diffPhases", () => {
  test("emits only changed stories present in both maps", () => {
    const before = { stable: "building" as const, changed: "reviewed" as const, removed: "implemented" as const };
    const after = { stable: "building" as const, changed: "building" as const, added: "verified" as const };

    const transitions = diffPhases(before, after);

    expect(transitions).toEqual([{ storyId: "changed", from: "reviewed", to: "building" }]);
  });

  test("returns no transitions for empty maps", () => {
    expect(diffPhases({}, {})).toEqual([]);
  });
});
