import { describe, expect, test } from "bun:test";

import {
  decideStepOutcome,
  filterSignalsForStory,
  lowerPhases,
  stepOutcomeReminderPrompt,
  type DecideStepOutcomeInput,
  type SignalRecord,
} from "../src/engine/step-outcome.ts";

function base(overrides: Partial<DecideStepOutcomeInput> = {}): DecideStepOutcomeInput {
  return {
    expects: "verified",
    phaseAfter: "reviewed",
    phaseAtStart: "reviewed",
    signals: [],
    storyId: "US-618E",
    reminderSent: false,
    remainingBudgetMs: 120_000,
    reminderMinMs: 60_000,
    stepName: "Verify",
    ...overrides,
  };
}

const EXACT_REMINDER = [
  `Your turn ended without running a looper signal for US-618E.`,
  `Use your bash/shell tool to run exactly one of these commands now. Do not write the command as assistant text; the engine only records a signal if the process actually runs.`,
  `looper signal story-phase verified`,
  `(only if this step's checklist fully passed and any fixes are committed)`,
  `looper signal story-phase <lower phase> --reason "<defect>"`,
  `(hand the story back)`,
  `looper signal blocked --reason "<what stopped you>"`,
  `looper signal no-op --reason "<why there was nothing to do>"`,
  `Do not start new work. Run the command, then stop.`,
].join("\n");

describe("decideStepOutcome", () => {
  test("returns done when phaseAfter meets expects", () => {
    const decision = decideStepOutcome(base({ phaseAfter: "verified" }));
    expect(decision).toEqual({ kind: "done" });
  });

  test("returns done when phaseAfter exceeds expects", () => {
    const decision = decideStepOutcome(base({ expects: "reviewed", phaseAfter: "merged" }));
    expect(decision).toEqual({ kind: "done" });
  });

  test("returns blocked from a blocked signal before reminder", () => {
    const signals: SignalRecord[] = [{ kind: "blocked", reason: "permission denied", at: 1 }];
    const decision = decideStepOutcome(base({ signals }));
    expect(decision).toEqual({ kind: "blocked", reason: "permission denied" });
  });

  test("returns done from a no-op signal with note", () => {
    const signals: SignalRecord[] = [{ kind: "no-op", reason: "already done upstream", at: 1 }];
    const decision = decideStepOutcome(base({ signals }));
    expect(decision).toEqual({ kind: "done", note: "already done upstream" });
  });

  test("returns done from a demotion story-phase signal", () => {
    const signals: SignalRecord[] = [
      { kind: "story-phase", phase: "building", reason: "tests failed", at: 1 },
    ];
    const decision = decideStepOutcome(
      base({ phaseAtStart: "reviewed", phaseAfter: "building", signals }),
    );
    expect(decision).toEqual({ kind: "done", note: "tests failed" });
  });

  test("ignores a non-demotion story-phase signal and continues", () => {
    const signals: SignalRecord[] = [{ kind: "story-phase", phase: "reviewed", at: 1 }];
    const decision = decideStepOutcome(
      base({
        phaseAtStart: "implemented",
        phaseAfter: "reviewed",
        expects: "verified",
        signals,
        reminderSent: false,
      }),
    );
    expect(decision).toEqual({ kind: "remind", prompt: EXACT_REMINDER });
  });

  test("returns done from an adjudicate signal", () => {
    const signals: SignalRecord[] = [{ kind: "adjudicate", reason: "oscillation", at: 1 }];
    const decision = decideStepOutcome(base({ signals }));
    expect(decision).toEqual({ kind: "done", note: "oscillation" });
  });

  test("returns blocked from engineBlockReason without reminder", () => {
    const decision = decideStepOutcome(
      base({ engineBlockReason: "permission gate timed out: external_directory" }),
    );
    expect(decision).toEqual({
      kind: "blocked",
      reason: "permission gate timed out: external_directory",
    });
  });

  test("returns blocked when remaining budget is below reminder minimum", () => {
    const decision = decideStepOutcome(base({ remainingBudgetMs: 59_999, reminderMinMs: 60_000 }));
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") throw new Error("expected blocked");
    expect(decision.reason).toContain("insufficient time");
  });

  test("returns remind with exact plan prompt when no signal and budget allows", () => {
    const decision = decideStepOutcome(base({ reminderSent: false }));
    expect(decision).toEqual({ kind: "remind", prompt: EXACT_REMINDER });
  });

  test("returns failed after reminder already sent", () => {
    const decision = decideStepOutcome(base({ reminderSent: true }));
    expect(decision).toEqual({
      kind: "failed",
      reason: "step ended without an outcome signal",
    });
  });

  test("prefers phase-met over signals", () => {
    const signals: SignalRecord[] = [{ kind: "blocked", reason: "should not win", at: 1 }];
    const decision = decideStepOutcome(base({ phaseAfter: "verified", signals }));
    expect(decision).toEqual({ kind: "done" });
  });

  test("filters story-scoped signals to the evaluation story; storyless match any", () => {
    const signals: SignalRecord[] = [
      { kind: "blocked", reason: "other story", storyId: "US-OTHER", at: 1 },
      { kind: "no-op", reason: "storyless applies", at: 2 },
    ];
    const decision = decideStepOutcome(base({ signals, storyId: "US-618E" }));
    expect(decision).toEqual({ kind: "done", note: "storyless applies" });
  });

  test("ignores other-story signals when no matching or storyless signal exists", () => {
    const signals: SignalRecord[] = [
      { kind: "blocked", reason: "other", storyId: "US-OTHER", at: 1 },
    ];
    const decision = decideStepOutcome(base({ signals, storyId: "US-618E", reminderSent: false }));
    expect(decision).toEqual({ kind: "remind", prompt: EXACT_REMINDER });
  });

  test("matches same-story scoped signal", () => {
    const signals: SignalRecord[] = [
      { kind: "blocked", reason: "this story blocked", storyId: "US-618E", at: 1 },
    ];
    const decision = decideStepOutcome(base({ signals, storyId: "US-618E" }));
    expect(decision).toEqual({ kind: "blocked", reason: "this story blocked" });
  });
});

describe("filterSignalsForStory", () => {
  test("keeps storyless and matching story ids only", () => {
    const signals: SignalRecord[] = [
      { kind: "blocked", reason: "a", storyId: "US-1", at: 1 },
      { kind: "no-op", reason: "b", at: 2 },
      { kind: "blocked", reason: "c", storyId: "US-2", at: 3 },
    ];
    expect(filterSignalsForStory(signals, "US-1").map((s) => s.reason)).toEqual(["a", "b"]);
    expect(filterSignalsForStory(signals, undefined).map((s) => s.reason)).toEqual(["b"]);
  });
});

describe("lowerPhases", () => {
  test("returns phases strictly below expects", () => {
    expect(lowerPhases("building")).toEqual([]);
    expect(lowerPhases("implemented")).toEqual(["building"]);
    expect(lowerPhases("verified")).toEqual(["building", "implemented", "reviewed"]);
  });
});

describe("stepOutcomeReminderPrompt", () => {
  test("matches the exact plan text", () => {
    const prompt = stepOutcomeReminderPrompt({
      stepName: "Verify",
      expects: "verified",
      storyId: "US-618E",
    });
    expect(prompt).toBe(EXACT_REMINDER);
  });
});
