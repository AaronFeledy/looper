import { buildAdjudicateReason } from "../lib/adjudication-files.ts";
import { loadAdjudicateStep } from "../lib/config.ts";
import {
  detectOscillation,
  diffPhases,
  type StoryPhasesMap,
  type StoryTransitionRecord,
} from "../lib/adjudication-detection.ts";
import type { LoadedStep } from "../lib/config.ts";
import { createStepRow, notify, type LoopState } from "../lib/state.ts";
import type { StoryPhase } from "../lib/story-state-files.ts";
import { prdFlipThreshold } from "../config/tunables.ts";
import { createAdjudicationStore } from "../persistence/adjudication-store.ts";
import type { AdjudicationStore } from "./engine-ports.ts";

export type StoryPhaseReader = (storyId: string) => StoryPhase | undefined;

export type AdjudicationConfig = {
  readonly store: AdjudicationStore;
  readonly step?: LoadedStep;
  readonly threshold: number;
  readonly now?: () => Date;
};

export type AdjudicationRuntime = AdjudicationConfig & {
  readonly writeStop: (reason: string) => void;
};

export function createAdjudicationConfig(input: {
  readonly configDir: string;
  readonly store?: AdjudicationStore;
  readonly configuredThreshold?: number;
}): AdjudicationConfig {
  const step = loadAdjudicateStep(input.configDir);
  return {
    // Factory fallback supports tests/bootstrap; production callers should inject the store.
    store: input.store ?? createAdjudicationStore({ configDir: input.configDir }),
    ...(step !== undefined ? { step } : {}),
    threshold: prdFlipThreshold(input.configuredThreshold),
  };
}

export type RoutingDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "adjudicate"; readonly step: LoadedStep }
  | { readonly kind: "stop"; readonly reason: string };

type RecordStepTransitionsInput = {
  readonly adjudication: AdjudicationConfig;
  readonly before: StoryPhasesMap | undefined;
  readonly after: StoryPhasesMap | undefined;
  readonly iteration: number;
  readonly stepName: string;
  readonly detect: boolean;
  /** Defaults to `"signal"` (step-window diffs). Engine resets pass `"engine"`. */
  readonly source?: "signal" | "engine";
};

/**
 * Prepend the adjudication trigger (the marker reason: which story oscillated
 * and its transition trail) to the adjudicator's prompt so the agent resolves
 * the detected conflict without having to discover the state files itself.
 */
export function withAdjudicationReason(prompt: string, reason: string | null): string {
  if (reason === null || reason.length === 0) return prompt;
  return `<adjudication-trigger>\n${reason}\n</adjudication-trigger>\n\n${prompt}`;
}

/**
 * Snapshot stored phases for the given story ids. Missing stored phase reads as
 * `"building"`. Returns `undefined` when there is no reader or no ids (caller
 * has nothing to diff).
 */
export function snapshotPhases(
  readPhase: StoryPhaseReader | undefined,
  storyIds: readonly string[] | undefined,
): StoryPhasesMap | undefined {
  if (readPhase === undefined || storyIds === undefined) return undefined;
  const phases: Record<string, StoryPhase> = {};
  for (const storyId of storyIds) {
    phases[storyId] = readPhase(storyId) ?? "building";
  }
  return phases;
}


export function recordStepTransitions(input: RecordStepTransitionsInput): void {
  if (input.before === undefined || input.after === undefined) return;
  const transitions = diffPhases(input.before, input.after);
  if (transitions.length === 0) return;
  const at = (input.adjudication.now ?? (() => new Date()))().toISOString();
  const source = input.source ?? "signal";
  const records: StoryTransitionRecord[] = transitions.map((transition) => ({
    ...transition,
    iteration: input.iteration,
    stepName: input.stepName,
    at,
    source,
  }));
  input.adjudication.store.appendHistory(records);
  if (!input.detect || input.adjudication.store.markerExists()) return;
  const verdict = detectOscillation(input.adjudication.store.readActiveHistory(), input.adjudication.threshold);
  if (verdict.oscillating) input.adjudication.store.writeMarker(buildAdjudicateReason(verdict));
}

export function decideRouting(adjudication: AdjudicationConfig | undefined): RoutingDecision {
  if (adjudication === undefined || !adjudication.store.markerExists()) return { kind: "continue" };
  if (adjudication.step !== undefined) return { kind: "adjudicate", step: adjudication.step };
  return { kind: "stop", reason: adjudication.store.readMarker() ?? "adjudication requested" };
}

export function insertAdjudicationRow(state: LoopState, stepName: string): number {
  state.steps.push(createStepRow(stepName));
  notify();
  return state.steps.length - 1;
}
