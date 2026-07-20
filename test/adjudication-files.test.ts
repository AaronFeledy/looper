import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  adjudicateMarkerExists,
  appendPrdHistory,
  buildAdjudicateReason,
  clearAdjudicateMarker,
  clearAdjudicateSession,
  clearPrdHistory,
  markPrdHistoryAdjudicated,
  readActivePrdHistory,
  readAdjudicateMarker,
  readAdjudicateSession,
  readPrdHistory,
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

  test("appends history across calls and survives a re-read", () => {
    const first: StoryTransitionRecord = {
      storyId: "story-a",
      from: false,
      to: true,
      iteration: 1,
      stepName: "build",
      at: "2026-07-18T00:00:01.000Z",
    };
    const second: StoryTransitionRecord = {
      storyId: "story-a",
      from: true,
      to: false,
      iteration: 2,
      stepName: "review",
      at: "2026-07-18T00:00:02.000Z",
    };

    appendPrdHistory([first]);
    appendPrdHistory([second]);

    expect(readPrdHistory()).toEqual([first, second]);
  });

  test("returns an empty history for a corrupt file", () => {
    writeFileSync(join(scratch, ".looper-prd-history.json"), "not json");

    expect(readPrdHistory()).toEqual([]);
  });

  test("quarantines a corrupt history file on append instead of destroying it", () => {
    // Given an existing history file that is present but unreadable.
    const historyPath = join(scratch, ".looper-prd-history.json");
    writeFileSync(historyPath, "not json");
    const fresh: StoryTransitionRecord = {
      storyId: "story-a",
      from: true,
      to: false,
      iteration: 1,
      stepName: "review",
      at: "2026-07-18T00:00:03.000Z",
    };

    // When a normal append runs.
    appendPrdHistory([fresh]);

    // Then the corrupt original is preserved alongside a fresh history containing only new records.
    const quarantined = readdirSync(scratch).filter((name) => name.startsWith(".looper-prd-history.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(scratch, quarantined[0]!), "utf8")).toBe("not json");
    expect(readPrdHistory()).toEqual([fresh]);
  });

  test("windows detection behind the adjudication watermark while retaining forensics", () => {
    // Given three recorded transitions.
    const records: StoryTransitionRecord[] = [1, 2, 3].map((iteration) => ({
      storyId: "story-a",
      from: iteration % 2 === 1,
      to: iteration % 2 === 0,
      iteration,
      stepName: "review",
      at: `2026-07-18T00:00:0${iteration}.000Z`,
    }));
    appendPrdHistory(records);

    // When the first two are marked adjudicated and a fourth is appended.
    markPrdHistoryAdjudicated();
    const fourth: StoryTransitionRecord = { storyId: "story-a", from: false, to: true, iteration: 4, stepName: "review", at: "2026-07-18T00:00:04.000Z" };
    appendPrdHistory([fourth]);

    // Then the active window excludes resolved records but the full trail is retained.
    expect(readActivePrdHistory()).toEqual([fourth]);
    expect(readPrdHistory()).toEqual([...records, fourth]);
  });

  test("round-trips and clears the adjudicator session record", () => {
    writeAdjudicateSession({ sessionID: "ses_adj", messageID: "msg_adj" });
    expect(readAdjudicateSession()).toEqual({ sessionID: "ses_adj", messageID: "msg_adj" });

    writeAdjudicateSession({ sessionID: "ses_only" });
    expect(readAdjudicateSession()).toEqual({ sessionID: "ses_only" });

    clearAdjudicateSession();
    expect(readAdjudicateSession()).toBeNull();
  });

  test("does not create a history file for an empty append", () => {
    appendPrdHistory([]);

    expect(existsSync(join(scratch, ".looper-prd-history.json"))).toBe(false);
  });

  test("clears history without clearing the adjudication marker", () => {
    const transition: StoryTransitionRecord = {
      storyId: "story-a",
      from: true,
      to: false,
      iteration: 1,
      stepName: "review",
      at: "2026-07-18T00:00:01.000Z",
    };
    writeAdjudicateMarker("contract conflict");
    appendPrdHistory([transition]);

    clearPrdHistory();

    expect(readPrdHistory()).toEqual([]);
    expect(readAdjudicateMarker()).toBe("contract conflict");
  });

  test("formats an adjudication reason with the complete trail", () => {
    const trail: readonly StoryTransitionRecord[] = [
      {
        storyId: "story-a",
        from: false,
        to: true,
        iteration: 1,
        stepName: "build",
        at: "2026-07-18T00:00:01.000Z",
      },
      {
        storyId: "story-a",
        from: true,
        to: false,
        iteration: 2,
        stepName: "review",
        at: "2026-07-18T00:00:02.000Z",
      },
    ];

    const reason = buildAdjudicateReason({ oscillating: true, storyId: "story-a", trail });

    expect(reason).toBe(
      [
        "PRD oscillation detected: story story-a flipped passes true->false 1 times.",
        "  - iteration 1 step build: false->true at 2026-07-18T00:00:01.000Z",
        "  - iteration 2 step review: true->false at 2026-07-18T00:00:02.000Z",
        "An adjudication step should resolve the contract conflict; see .looper-prd-history.json.",
      ].join("\n"),
    );
  });
});
