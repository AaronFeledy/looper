export type PrdPassesMap = Readonly<Record<string, boolean>>;

export type PrdTransition = {
  readonly storyId: string;
  readonly from: boolean;
  readonly to: boolean;
};

export type StoryTransitionRecord = {
  readonly storyId: string;
  readonly from: boolean;
  readonly to: boolean;
  readonly iteration: number;
  readonly stepName: string;
  readonly at: string;
};

export type OscillationVerdict =
  | { readonly oscillating: false }
  | {
      readonly oscillating: true;
      readonly storyId: string;
      readonly trail: readonly StoryTransitionRecord[];
    };

export function diffPasses(before: PrdPassesMap, after: PrdPassesMap): PrdTransition[] {
  const transitions: PrdTransition[] = [];
  for (const [storyId, beforePasses] of Object.entries(before)) {
    const afterPasses = after[storyId];
    if (afterPasses === undefined || beforePasses === afterPasses) continue;
    transitions.push({ storyId, from: beforePasses, to: afterPasses });
  }
  return transitions;
}

export function detectOscillation(history: readonly StoryTransitionRecord[], threshold: number): OscillationVerdict {
  // Non-positive thresholds disable detection rather than making every history oscillate.
  if (threshold <= 0) return { oscillating: false };

  const qualifyingCounts = new Map<string, number>();
  for (const transition of history) {
    if (!qualifyingCounts.has(transition.storyId)) qualifyingCounts.set(transition.storyId, 0);
    if (transition.from && !transition.to) {
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
