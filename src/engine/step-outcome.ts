import type { StoryPhase } from "../lib/story-state-files.ts";
import { comparePhase, STORY_PHASE_ORDER } from "../lib/story-state-files.ts";
import { outcomeReminderMinMs as outcomeReminderMinMsTunable } from "../config/tunables.ts";

export type OutcomeSignalKind = "blocked" | "no-op" | "story-phase" | "adjudicate";

/** Signal record as read from the signals log (or an equivalent in-memory source). */
export type SignalRecord = {
  readonly kind: OutcomeSignalKind;
  readonly storyId?: string;
  readonly phase?: StoryPhase;
  readonly reason?: string;
  readonly at: number | string;
};

/** @deprecated Prefer {@link SignalRecord}. */
export type OutcomeSignalRecord = SignalRecord;

export type DecideStepOutcomeInput = {
  readonly expects: StoryPhase;
  /** Effective/stored phase recorded at step start (for demotion detection). */
  readonly phaseAtStart: StoryPhase;
  /** Effective phase after the step attempt. */
  readonly phaseAfter: StoryPhase;
  /** Signals since step start; filtered to evaluation story (or storyless). */
  readonly signals: readonly SignalRecord[];
  /** Evaluation story id; story-scoped signals must match; storyless match any. */
  readonly storyId?: string;
  readonly reminderSent: boolean;
  /** Engine-side block (e.g. permission gate_timeout). */
  readonly engineBlockReason?: string;
  readonly remainingBudgetMs: number;
  /** Default from LOOPER_OUTCOME_REMINDER_MIN_MS (60000); overridable for tests. */
  readonly reminderMinMs?: number;
  readonly stepName: string;
};

export type StepOutcomeDecision =
  | { readonly kind: "done"; readonly note?: string }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "remind"; readonly prompt: string }
  | { readonly kind: "failed"; readonly reason: string };

/** Phases strictly below `expects` (for demotion / hand-back wording). */
export function lowerPhases(expects: StoryPhase): readonly StoryPhase[] {
  const idx = STORY_PHASE_ORDER.indexOf(expects);
  if (idx <= 0) return [];
  return STORY_PHASE_ORDER.slice(0, idx);
}

function reminderMinMs(value: number | undefined): number {
  if (value !== undefined) return value >= 0 && Number.isFinite(value) ? value : outcomeReminderMinMsTunable();
  return outcomeReminderMinMsTunable();
}

/**
 * Keep signals that apply to the evaluation story: storyless records match any
 * story; story-scoped records match only when `storyId` equals the evaluation id.
 * When no evaluation story is set, only storyless signals apply.
 */
export function filterSignalsForStory(
  signals: readonly SignalRecord[],
  storyId: string | undefined,
): SignalRecord[] {
  return signals.filter((signal) => {
    if (signal.storyId === undefined || signal.storyId.length === 0) return true;
    if (storyId === undefined) return false;
    return signal.storyId === storyId;
  });
}

/**
 * Pure post-attempt outcome decision for steps with `expects: <StoryPhase>`.
 * Call after the attempt loop yields `done`, before `setsPhase`.
 *
 * Rules (in order):
 * 1. phaseAfter ≥ expects → done
 * 2. matching signal: blocked → blocked; no-op → done; demotion story-phase → done; adjudicate → done
 * 3. engineBlockReason or remainingBudgetMs < reminderMinMs → blocked (no reminder)
 * 4. !reminderSent → remind with exact prompt
 * 5. otherwise → failed
 */
export function decideStepOutcome(input: DecideStepOutcomeInput): StepOutcomeDecision {
  if (comparePhase(input.phaseAfter, input.expects) >= 0) {
    return { kind: "done" };
  }

  const signals = filterSignalsForStory(input.signals, input.storyId);
  for (const signal of signals) {
    switch (signal.kind) {
      case "blocked":
        return { kind: "blocked", reason: signal.reason ?? "blocked" };
      case "no-op":
        return { kind: "done", note: signal.reason };
      case "story-phase": {
        if (signal.phase !== undefined && comparePhase(signal.phase, input.phaseAtStart) < 0) {
          return { kind: "done", note: signal.reason };
        }
        break;
      }
      case "adjudicate":
        return { kind: "done", note: signal.reason };
      default: {
        const _exhaustive: never = signal.kind;
        return _exhaustive;
      }
    }
  }

  if (input.engineBlockReason !== undefined && input.engineBlockReason.length > 0) {
    return { kind: "blocked", reason: input.engineBlockReason };
  }

  const minMs = reminderMinMs(input.reminderMinMs);
  if (input.remainingBudgetMs < minMs) {
    return {
      kind: "blocked",
      reason: `insufficient time for outcome reminder (remaining ${input.remainingBudgetMs}ms < ${minMs}ms)`,
    };
  }

  if (!input.reminderSent) {
    const storyId = input.storyId ?? "the current story";
    return {
      kind: "remind",
      prompt: stepOutcomeReminderPrompt({
        stepName: input.stepName,
        expects: input.expects,
        storyId,
      }),
    };
  }

  return {
    kind: "failed",
    reason: "step ended without an outcome signal",
  };
}

export function stepOutcomeReminderPrompt(input: {
  readonly stepName: string;
  readonly expects: StoryPhase;
  readonly storyId: string;
}): string {
  const expects = input.expects;
  const storyId = input.storyId;
  return [
    `Your turn ended without running a looper signal for ${storyId}.`,
    `Use your bash/shell tool to run exactly one of these commands now. Do not write the command as assistant text; the engine only records a signal if the process actually runs.`,
    `looper signal story-phase ${expects}`,
    `(only if this step's checklist fully passed and any fixes are committed)`,
    `looper signal story-phase <lower phase> --reason "<defect>"`,
    `(hand the story back)`,
    `looper signal blocked --reason "<what stopped you>"`,
    `looper signal no-op --reason "<why there was nothing to do>"`,
    `Do not start new work. Run the command, then stop.`,
  ].join("\n");
}
