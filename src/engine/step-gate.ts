import type { GateConfig } from "../lib/config.ts";
import { DEFAULT_STORY_ID_PATTERN } from "../lib/story-id.ts";
import { comparePhase, type StoryPhase } from "../lib/story-state-files.ts";
import type { GateScriptResult } from "../platform/gate-script.ts";

export { runGateScript } from "../platform/gate-script.ts";
export type { GateScriptOptions, GateScriptResult } from "../platform/gate-script.ts";

/**
 * Gate shape evaluated by {@link evaluateGate}. Matches loaded {@link GateConfig}
 * (YAML `prdPasses` is aliased to `phase: implemented` at load time and never reaches here).
 */
export type GateEvaluationConfig = {
  readonly branch?: GateConfig["branch"];
  readonly phase?: StoryPhase;
  readonly phaseBelow?: StoryPhase;
  readonly script?: string;
};

export type GateInputs = {
  readonly gate: GateEvaluationConfig;
  readonly branch: string | undefined;
  readonly branchStoryId?: string | null;
  /** Evaluated story: branch story id if resolvable, else selected next, else undefined. */
  readonly storyId: string | undefined;
  /** Effective phase of the evaluated story; missing reads as `building` when a story is present. */
  readonly phase: StoryPhase | undefined;
  readonly storyIdPattern?: string;
  readonly scriptResult?: GateScriptResult;
};

export type GateDecision = { readonly pass: true } | { readonly pass: false; readonly reason: string };

function currentBranchLabel(branch: string | undefined): string {
  return branch === undefined ? "no current branch" : `current '${branch}'`;
}

function expectedStoryPattern(pattern: string | undefined): string {
  return pattern ?? DEFAULT_STORY_ID_PATTERN;
}

export function evaluateGate(inputs: GateInputs): GateDecision {
  const branchStoryId = "branchStoryId" in inputs ? inputs.branchStoryId : inputs.storyId;
  if (inputs.gate.branch === "story" && branchStoryId == null) {
    return {
      pass: false,
      reason: `gate: branch is not a story branch (${currentBranchLabel(inputs.branch)}; expected a name matching ${expectedStoryPattern(inputs.storyIdPattern)} or prefixed with an exact configured PRD story ID followed by '-')`,
    };
  }
  if (inputs.gate.branch === "main" && inputs.branch !== "main") {
    return {
      pass: false,
      reason: `gate: branch is not main (${currentBranchLabel(inputs.branch)}; expected 'main')`,
    };
  }

  if (inputs.gate.phase !== undefined) {
    const currentPhase = inputs.phase ?? "building";
    if (comparePhase(currentPhase, inputs.gate.phase) < 0) {
      return {
        pass: false,
        reason: `gate: phase ${currentPhase} is before ${inputs.gate.phase} (expected phase at or past ${inputs.gate.phase})`,
      };
    }
  }

  // Skip when the evaluated story is already at or past phaseBelow (nothing to do).
  // No evaluated story → fail open (condition passes).
  if (inputs.gate.phaseBelow !== undefined && inputs.storyId !== undefined) {
    const currentPhase = inputs.phase ?? "building";
    if (comparePhase(currentPhase, inputs.gate.phaseBelow) >= 0) {
      return {
        pass: false,
        reason: `gate: phase ${currentPhase} is at or past ${inputs.gate.phaseBelow} (nothing to do)`,
      };
    }
  }

  if (inputs.gate.script !== undefined) {
    if (inputs.scriptResult === undefined) return { pass: false, reason: "gate: script did not run" };
    if (!inputs.scriptResult.ran) {
      return { pass: false, reason: `gate: script failed: ${inputs.scriptResult.error ?? "unknown error"}` };
    }
    if (inputs.scriptResult.exitCode === undefined) {
      return { pass: false, reason: "gate: script did not report an exit code" };
    }
    if (inputs.scriptResult.exitCode !== 0) {
      return { pass: false, reason: `gate: script exited with code ${inputs.scriptResult.exitCode}` };
    }
  }

  return { pass: true };
}
