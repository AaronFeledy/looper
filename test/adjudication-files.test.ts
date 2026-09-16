import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  adjudicateMarkerExists,
  appendPhaseHistory,
  buildAdjudicateReason,
  clearAdjudicateMarker,
  clearAdjudicateSession,
  clearPhaseHistory,
  markPhaseHistoryAdjudicated,
  readActivePhaseHistory,
  readAdjudicateMarker,
  readAdjudicateSession,
  readPhaseHistory,
  writeAdjudicateMarker,
  writeAdjudicateSession,
} from "../src/lib/adjudication-files.ts";
import type { StoryTransitionRecord } from "../src/lib/adjudication-detection.ts";
import { initStatePaths } from "../src/lib/state-files.ts";

const TMP_ROOT = join(import.meta.dir, ".tmp");

describe("adjudication files", () => {
  let scratch: string;

  beforeEach(() => {
    mkdirSync(TMP_ROOT, { recursive: true });
    scratch = mkdtempSync(join(TMP_ROOT, "adjudication-"));
    initStatePaths({ configDir: scratch });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("round-trips and clears an adjudication marker", () => {
    writeAdjudicateMarker("contract conflict");

    expect(adjudicateMarkerExists()).toBe(true);
    expect(readAdjudicateMarker()).toBe("contract conflict");

    clearAdjudicateMarker();
    expect(adjudicateMarkerExists()).toBe(false);
    expect(readAdjudicateMarker()).toBeNull();
  });

  test("reports a missing adjudication marker", () => {
    expect(adjudicateMarkerExists()).toBe(false);
    expect(readAdjudicateMarker()).toBeNull();
  });

  test("appends phase history across calls and survives a re-read", () => {
    const first: StoryTransitionRecord = {
      storyId: "story-a",
      from: "building",
      to: "reviewed",
      iteration: 1,
      stepName: "build",
      at: "2026-07-18T00:00:01.000Z",
      source: "signal",
    };
    const second: StoryTransitionRecord = {
      storyId: "story-a",
      from: "reviewed",
      to: "building",
      iteration: 2,
      stepName: "review",
      at: "2026-07-18T00:00:02.000Z",
      source: "signal",
    };

    appendPhaseHistory([first]);
    appendPhaseHistory([second]);

    expect(readPhaseHistory()).toEqual([first, second]);
    expect(existsSync(join(scratch, ".looper-phase-history.json"))).toBe(true);
  });

  test("returns an empty history for a corrupt file", () => {
    writeFileSync(join(scratch, ".looper-phase-history.json"), "not json");

    expect(readPhaseHistory()).toEqual([]);
  });

  test("quarantines a corrupt history file on append instead of destroying it", () => {
    // Given an existing history file that is present but unreadable.
    const historyPath = join(scratch, ".looper-phase-history.json");
    writeFileSync(historyPath, "not json");
    const fresh: StoryTransitionRecord = {
      storyId: "story-a",
      from: "reviewed",
      to: "building",
      iteration: 1,
      stepName: "review",
      at: "2026-07-18T00:00:03.000Z",
      source: "signal",
    };

    // When a normal append runs.
    appendPhaseHistory([fresh]);

    // Then the corrupt original is preserved alongside a fresh history containing only new records.
    const quarantined = readdirSync(scratch).filter((name) => name.startsWith(".looper-phase-history.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(scratch, quarantined[0]!), "utf8")).toBe("not json");
    expect(readPhaseHistory()).toEqual([fresh]);
  });

  test("windows detection behind the adjudication watermark while retaining forensics", () => {
    // Given three recorded transitions.
    const records: StoryTransitionRecord[] = [1, 2, 3].map((iteration) => ({
      storyId: "story-a",
      from: iteration % 2 === 1 ? ("reviewed" as const) : ("building" as const),
      to: iteration % 2 === 0 ? ("reviewed" as const) : ("building" as const),
      iteration,
      stepName: "review",
      at: `2026-07-18T00:00:0${iteration}.000Z`,
      source: "signal" as const,
    }));
    appendPhaseHistory(records);

    // When the first two are marked adjudicated and a fourth is appended.
    markPhaseHistoryAdjudicated();
    const fourth: StoryTransitionRecord = {
      storyId: "story-a",
      from: "building",
      to: "reviewed",
      iteration: 4,
      stepName: "review",
      at: "2026-07-18T00:00:04.000Z",
      source: "signal",
    };
    appendPhaseHistory([fourth]);

    // Then the active window excludes resolved records but the full trail is retained.
    expect(readActivePhaseHistory()).toEqual([fourth]);
    expect(readPhaseHistory()).toEqual([...records, fourth]);
  });

  test("round-trips and clears the adjudicator session record", () => {
    writeAdjudicateSession({ sessionID: "ses_adj", messageID: "msg_adj" });
    expect(readAdjudicateSession()).toEqual({ kind: "ok", session: { sessionID: "ses_adj", messageID: "msg_adj" } });

    writeAdjudicateSession({ sessionID: "ses_only" });
    expect(readAdjudicateSession()).toEqual({ kind: "ok", session: { sessionID: "ses_only" } });

    clearAdjudicateSession();
    expect(readAdjudicateSession()).toEqual({ kind: "absent" });
  });

  test("distinguishes a corrupt adjudicator session record from an absent record", () => {
    writeFileSync(join(scratch, ".looper-adjudicate-session.json"), "not json");

    expect(readAdjudicateSession()).toEqual({ kind: "corrupt" });
  });

  test("does not create a history file for an empty append", () => {
    appendPhaseHistory([]);

    expect(existsSync(join(scratch, ".looper-phase-history.json"))).toBe(false);
  });

  test("clears history without clearing the adjudication marker", () => {
    const transition: StoryTransitionRecord = {
      storyId: "story-a",
      from: "reviewed",
      to: "building",
      iteration: 1,
      stepName: "review",
      at: "2026-07-18T00:00:01.000Z",
      source: "signal",
    };
    writeAdjudicateMarker("contract conflict");
    appendPhaseHistory([transition]);

    clearPhaseHistory();

    expect(readPhaseHistory()).toEqual([]);
    expect(readAdjudicateMarker()).toBe("contract conflict");
  });

  test("formats an adjudication reason with the complete trail", () => {
    const trail: readonly StoryTransitionRecord[] = [
      {
        storyId: "story-a",
        from: "building",
        to: "reviewed",
        iteration: 1,
        stepName: "build",
        at: "2026-07-18T00:00:01.000Z",
        source: "signal",
      },
      {
        storyId: "story-a",
        from: "reviewed",
        to: "building",
        iteration: 2,
        stepName: "review",
        at: "2026-07-18T00:00:02.000Z",
        source: "signal",
      },
    ];

    const reason = buildAdjudicateReason({ oscillating: true, storyId: "story-a", trail });

    expect(reason).toBe(
      [
        "Phase oscillation detected: story story-a was demoted 1 times (reviewed→building).",
        "  - iteration 1 step build: building->reviewed (signal) at 2026-07-18T00:00:01.000Z",
        "  - iteration 2 step review: reviewed->building (signal) at 2026-07-18T00:00:02.000Z",
        "An adjudication step should resolve the contract conflict; see .looper-phase-history.json.",
      ].join("\n"),
    );
  });
});
