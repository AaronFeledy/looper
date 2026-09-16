import { comparePhase, type StoryPhase } from "./story-state-files.ts";

export type StoryPhasesMap = Readonly<Record<string, StoryPhase>>;

export type PhaseTransition = {
  readonly storyId: string;
  readonly from: StoryPhase;
  readonly to: StoryPhase;
};

export type StoryTransitionRecord = {
  readonly storyId: string;
  readonly from: StoryPhase;
  readonly to: StoryPhase;
  readonly iteration: number;
  readonly stepName: string;
  readonly at: string;
  /** `signal` = agent/operator story-phase write; `engine` = engine reset (never counts as demotion). */
  readonly source: "signal" | "engine";
};

export type OscillationVerdict =
  | { readonly oscillating: false }
  | {
      readonly oscillating: true;
      readonly storyId: string;
      readonly trail: readonly StoryTransitionRecord[];
    };

/**
 * Emit phase transitions for stories present in both maps whose phase changed.
 * Callers should normalize missing stored phases to `"building"` before diffing.
 */
export function diffPhases(before: StoryPhasesMap, after: StoryPhasesMap): PhaseTransition[] {
  const transitions: PhaseTransition[] = [];
  for (const [storyId, beforePhase] of Object.entries(before)) {
    const afterPhase = after[storyId];
    if (afterPhase === undefined || beforePhase === afterPhase) continue;
    transitions.push({ storyId, from: beforePhase, to: afterPhase });
  }
  return transitions;
}

/**
 * Oscillation = a story was demoted (to < from) by a `signal` source at least
 * `threshold` times in the active history window. Engine-sourced records
 * (phase resets on new commits) never count. `prdFlipThreshold` config/env
 * names are retained as the demotion threshold.
 */
export function detectOscillation(history: readonly StoryTransitionRecord[], threshold: number): OscillationVerdict {
  // Non-positive thresholds disable detection rather than making every history oscillate.
  if (threshold <= 0) return { oscillating: false };

  const qualifyingCounts = new Map<string, number>();
  for (const transition of history) {
    if (!qualifyingCounts.has(transition.storyId)) qualifyingCounts.set(transition.storyId, 0);
    if (transition.source === "signal" && comparePhase(transition.to, transition.from) < 0) {
      qualifyingCounts.set(transition.storyId, (qualifyingCounts.get(transition.storyId) ?? 0) + 1);
    }
  }

  let selectedStoryId: string | null = null;
  let selectedCount = 0;
  for (const [storyId, count] of qualifyingCounts) {
    if (count >= threshold && count > selectedCount) {
      selectedStoryId = storyId;
      selectedCount = count;
    }
  }

  if (selectedStoryId === null) return { oscillating: false };
  return {
    oscillating: true,
    storyId: selectedStoryId,
    trail: history.filter((transition) => transition.storyId === selectedStoryId),
  };
}
