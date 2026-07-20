import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildAdjudicateReason } from "../lib/adjudication-files.ts";
import { loadAdjudicateStep } from "../lib/config.ts";
import {
  detectOscillation,
  diffPasses,
  type PrdPassesMap,
  type StoryTransitionRecord,
} from "../lib/adjudication-detection.ts";
import type { LoadedStep } from "../lib/config.ts";
import { createStepRow, notify, type LoopState } from "../lib/state.ts";
import { prdFlipThreshold } from "../config/tunables.ts";
import { createAdjudicationStore, type AdjudicationStore } from "../persistence/adjudication-store.ts";

export type PrdPassesReader = (prdDir: string) => PrdPassesMap | undefined;

export type AdjudicationConfig = {
  readonly store: AdjudicationStore;
  readonly step?: LoadedStep;
  readonly threshold: number;
  readonly readPasses?: PrdPassesReader;
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
  readonly before: PrdPassesMap | undefined;
  readonly after: PrdPassesMap | undefined;
  readonly iteration: number;
  readonly stepName: string;
  readonly detect: boolean;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPrdPasses(prdDir: string): PrdPassesMap | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(prdDir, "prd.json"), "utf8"));
  } catch {
    // Absent or unparseable prd.json: no snapshot this step (matches the
    // canonical reader treating these as "cannot count").
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["userStories"])) return undefined;
  // Per-story tolerance mirrors the canonical PRD reader (src/lib/prd.ts): a
  // story passes only when `passes === true`; any other shape counts as not
  // passing. Skip stories without a usable id (they can't be tracked) instead
  // of discarding the whole snapshot, so one malformed entry can't silently
  // disable detection for every valid story.
  const passes: Record<string, boolean> = {};
  for (const story of parsed["userStories"]) {
    if (!isRecord(story)) continue;
    const id = story["id"];
    if (typeof id !== "string" || id.length === 0) continue;
    passes[id] = story["passes"] === true;
  }
  return passes;
}

/**
 * Prepend the adjudication trigger (the marker reason: which story oscillated
 * and its transition trail) to the adjudicator's prompt so the agent resolves
 * the detected conflict without having to discover the state files itself.
 */
export function withAdjudicationReason(prompt: string, reason: string | null): string {
  if (reason === null || reason.length === 0) return prompt;
  return `<adjudication-trigger>\n${reason}\n</adjudication-trigger>\n\n${prompt}`;
}

export function snapshotPrd(adjudication: AdjudicationConfig | undefined, prdDir: string | undefined): PrdPassesMap | undefined {
  if (adjudication === undefined || prdDir === undefined) return undefined;
  return (adjudication.readPasses ?? readPrdPasses)(prdDir);
}

export function recordStepTransitions(input: RecordStepTransitionsInput): void {
  if (input.before === undefined || input.after === undefined) return;
  const transitions = diffPasses(input.before, input.after);
  if (transitions.length === 0) return;
  const at = (input.adjudication.now ?? (() => new Date()))().toISOString();
  const records: StoryTransitionRecord[] = transitions.map((transition) => ({
    ...transition,
    iteration: input.iteration,
    stepName: input.stepName,
    at,
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
