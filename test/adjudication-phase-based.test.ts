import { describe, expect, test } from "bun:test";

import {
  recordStepTransitions,
  snapshotPhases,
  type AdjudicationConfig,
} from "../src/engine/adjudication-routing.ts";
import type { StoryPhase } from "../src/lib/story-state-files.ts";
import { createInMemoryAdjudicationStore } from "./helpers/adjudication-stub.ts";

describe("snapshotPhases", () => {
  test("maps each story id to its stored StoryPhase", () => {
    const stored: Record<string, StoryPhase> = {
      "US-1": "reviewed",
      "US-2": "implemented",
    };

    expect(snapshotPhases((id) => stored[id], ["US-1", "US-2"])).toEqual({
      "US-1": "reviewed",
      "US-2": "implemented",
    });
  });

  test("treats a missing stored phase as building rather than discarding the story", () => {
    const stored: Record<string, StoryPhase> = { "US-1": "verified" };

    expect(snapshotPhases((id) => stored[id], ["US-1", "US-missing"])).toEqual({
      "US-1": "verified",
      "US-missing": "building",
    });
  });

  test("returns undefined when there is no phase reader", () => {
    expect(snapshotPhases(undefined, ["US-1"])).toBeUndefined();
  });

  test("returns undefined when story ids are not provided", () => {
    expect(snapshotPhases(() => "reviewed", undefined)).toBeUndefined();
  });

  test("returns an empty map for an empty story-id list", () => {
    expect(snapshotPhases(() => "reviewed", [])).toEqual({});
  });
});

describe("recordStepTransitions", () => {
  function config(overrides?: Partial<AdjudicationConfig>): AdjudicationConfig {
    return {
      store: createInMemoryAdjudicationStore(),
      threshold: 2,
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      ...overrides,
    };
  }

  test("appends signal-sourced phase transitions for stories that changed", () => {
    const adjudication = config();

    recordStepTransitions({
      adjudication,
      before: { "US-1": "reviewed", "US-2": "building" },
      after: { "US-1": "building", "US-2": "building" },
      iteration: 3,
      stepName: "review",
      detect: false,
    });

    expect(adjudication.store.readHistory()).toEqual([
      {
        storyId: "US-1",
        from: "reviewed",
        to: "building",
        iteration: 3,
        stepName: "review",
        at: "2026-09-14T12:00:00.000Z",
        source: "signal",
      },
    ]);
  });

  test("records an explicit engine source instead of the signal default", () => {
    const adjudication = config();

    recordStepTransitions({
      adjudication,
      before: { "US-1": "reviewed" },
      after: { "US-1": "building" },
      iteration: 1,
      stepName: "build",
      detect: false,
      source: "engine",
    });

    expect(adjudication.store.readHistory()).toEqual([
      {
        storyId: "US-1",
        from: "reviewed",
        to: "building",
        iteration: 1,
        stepName: "build",
        at: "2026-09-14T12:00:00.000Z",
        source: "engine",
      },
    ]);
  });

  test("is a no-op when either phase snapshot is unavailable", () => {
    const adjudication = config();

    recordStepTransitions({
      adjudication,
      before: undefined,
      after: { "US-1": "building" },
      iteration: 1,
      stepName: "build",
      detect: true,
    });
    recordStepTransitions({
      adjudication,
      before: { "US-1": "building" },
      after: undefined,
      iteration: 1,
      stepName: "build",
      detect: true,
    });

    expect(adjudication.store.readHistory()).toEqual([]);
    expect(adjudication.store.markerExists()).toBe(false);
  });

  test("skips history writes when the phase maps are unchanged", () => {
    const adjudication = config();

    recordStepTransitions({
      adjudication,
      before: { "US-1": "reviewed" },
      after: { "US-1": "reviewed" },
      iteration: 1,
      stepName: "build",
      detect: true,
    });

    expect(adjudication.store.readHistory()).toEqual([]);
  });

  test("writes an adjudication marker when detect finds signal demotions at threshold", () => {
    const adjudication = config({ threshold: 2 });

    // First demotion alone stays below threshold.
    recordStepTransitions({
      adjudication,
      before: { "US-1": "reviewed" },
      after: { "US-1": "building" },
      iteration: 1,
      stepName: "review",
      detect: true,
    });
    expect(adjudication.store.markerExists()).toBe(false);

    // Recovery then second demotion trips the threshold.
    recordStepTransitions({
      adjudication,
      before: { "US-1": "building" },
      after: { "US-1": "reviewed" },
      iteration: 2,
      stepName: "build",
      detect: true,
    });
    recordStepTransitions({
      adjudication,
      before: { "US-1": "reviewed" },
      after: { "US-1": "building" },
      iteration: 3,
      stepName: "review",
      detect: true,
    });

    expect(adjudication.store.markerExists()).toBe(true);
    expect(adjudication.store.readMarker()).toContain("US-1");
    expect(adjudication.store.readHistory()).toHaveLength(3);
    expect(adjudication.store.readHistory().every((r) => r.source === "signal")).toBe(true);
  });

  test("does not write a marker when detect is false even if demotions would qualify", () => {
    const adjudication = config({ threshold: 1 });

    recordStepTransitions({
      adjudication,
      before: { "US-1": "reviewed" },
      after: { "US-1": "building" },
      iteration: 1,
      stepName: "review",
      detect: false,
    });

    expect(adjudication.store.readHistory()).toHaveLength(1);
    expect(adjudication.store.markerExists()).toBe(false);
  });
});
