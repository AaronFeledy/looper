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
  /** Effective/stored phase recorded at step start (for hand-back wording). */
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

/**
 * A step's disposition, decided from what the agent SAID (its signals), never
 * from how far the phase map moved. `done` is the only advancing outcome;
 * `handback` and `blocked` are explicit non-advancing outcomes that the attempt
 * ledger counts; `noop` means there was legitimately nothing to do.
 */
export type StepOutcomeDecision =
  | { readonly kind: "done"; readonly note?: string }
  | { readonly kind: "handback"; readonly reason: string; readonly phase: StoryPhase }
  | { readonly kind: "noop"; readonly note?: string }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "remind"; readonly prompt: string };

/** Phases strictly below `expects` (the legal hand-back targets). */
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

export type OutcomeCommand = {
  readonly command: string;
  readonly when: string;
};

/**
 * The exact, complete set of outcome commands that are legal for this step.
 *
 * This is the ONE source of truth: it feeds both the `<looper-context>` block the
 * agent reads up front and the reminder prompt it gets when its turn ends silently.
 * Step prompts must NOT restate it -- a hand-maintained copy drifts, and a prompt
 * that advertises an illegal move (e.g. "hand back to a lower phase" for a story
 * already at `building`) sets the agent up to comply and then be failed for it.
 */
export function legalOutcomeCommands(input: {
  readonly expects: StoryPhase;
  readonly storyId?: string;
}): readonly OutcomeCommand[] {
  const story = input.storyId ?? "this story";
  const handbackTargets = lowerPhases(input.expects);
  const handbackArg =
    handbackTargets.length === 0
      ? undefined
      : handbackTargets.length === 1
        ? handbackTargets[0]
        : `<${handbackTargets.join("|")}>`;
  return [
    {
      command: `looper signal story-phase ${input.expects}`,
      when: `this step's work is complete and committed: ${story} is now at ${input.expects}`,
    },
    ...(handbackArg === undefined
      ? []
      : [
          {
            command: `looper signal story-phase ${handbackArg} --reason "<defect>"`,
            when: `attempted, but ${story} did not reach ${input.expects}; name the defect so the next pass can fix it`,
          },
        ]),
    {
      command: `looper signal blocked --reason "<what stopped you>"`,
      when: "you could not proceed at all (environment, permissions, missing input)",
    },
    {
      command: `looper signal no-op --reason "<why>"`,
      when: "there was legitimately nothing for this step to do",
    },
  ];
}

/**
 * Pure post-attempt outcome decision for steps with `expects: <StoryPhase>`.
 * Call after the attempt loop yields `done`, before `setsPhase`.
 *
 * Classification is by SIGNAL CONTENT, not by phase delta. A story-phase signal
 * below `expects` is the agent explicitly saying "I did not get there", which is a
 * real outcome even when it re-asserts the phase the story already had -- the
 * common case for a step whose `expects` sits one rung above the entry phase
 * (Build at `building`, Push at `verified`), where no demotion is even expressible.
 * Deriving the outcome from a phase delta instead is the same lossy inversion that
 * `story-phases.ts` documents and deletes for git refs: state is a projection of
 * what happened, so reading intent back out of it loses exactly the cases that
 * matter.
 *
 * Rules (in order):
 * 1. phaseAfter >= expects -> done
 * 2. matching signal: blocked -> blocked; no-op/adjudicate -> noop;
 *    story-phase below expects -> handback
 * 3. engineBlockReason or remainingBudgetMs < reminderMinMs -> blocked (no reminder)
 * 4. !reminderSent -> remind with the exact legal command list
 * 5. otherwise -> blocked (silence is unreadable, not fatal: the attempt ledger
 *    escalates a step that keeps failing, so one mute turn must not kill the run)
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
        return { kind: "noop", ...(signal.reason !== undefined ? { note: signal.reason } : {}) };
      case "story-phase": {
        // Any asserted phase below `expects` is an explicit hand-back, including one
        // equal to the phase the story started at. A claim at or above `expects` is
        // already handled by rule 1 via phaseAfter.
        if (signal.phase !== undefined && comparePhase(signal.phase, input.expects) < 0) {
          return {
            kind: "handback",
            reason: signal.reason ?? `handed back at ${signal.phase} without a stated reason`,
            phase: signal.phase,
          };
        }
        break;
      }
      case "adjudicate":
        // Adjudication is itself the escalation; never counted as a failed attempt.
        return { kind: "noop", ...(signal.reason !== undefined ? { note: signal.reason } : {}) };
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
    return {
      kind: "remind",
      prompt: stepOutcomeReminderPrompt({
        stepName: input.stepName,
        expects: input.expects,
        ...(input.storyId !== undefined ? { storyId: input.storyId } : {}),
      }),
    };
  }

  return {
    kind: "blocked",
    reason: "step ended without an outcome signal after a reminder",
  };
}

export function stepOutcomeReminderPrompt(input: {
  readonly stepName: string;
  readonly expects: StoryPhase;
  readonly storyId?: string;
}): string {
  const story = input.storyId ?? "the current story";
  const commands = legalOutcomeCommands({
    expects: input.expects,
    ...(input.storyId !== undefined ? { storyId: input.storyId } : {}),
  });
  return [
    `Your turn ended without running a looper signal for ${story}.`,
    `Run exactly one of these with your bash/shell tool now. Do not write the command as assistant text; the engine only records a signal if the process actually runs.`,
    ...commands.map(({ command, when }) => `${command}\n  (${when})`),
    `Do not start new work. Run the command, then stop.`,
  ].join("\n");
}
