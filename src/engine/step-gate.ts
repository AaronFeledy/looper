import type { GateConfig } from "../lib/config.ts";
import { comparePhase, type StoryPhase } from "../lib/story-state-files.ts";
import type { GateScriptResult } from "../platform/gate-script.ts";

export { runGateScript } from "../platform/gate-script.ts";
export type { GateScriptOptions, GateScriptResult } from "../platform/gate-script.ts";

export type GateInputs = {
  readonly gate: GateConfig;
  readonly branch: string | undefined;
  readonly storyId: string | undefined;
  readonly passes: boolean | undefined;
  readonly phase: StoryPhase | undefined;
  readonly scriptResult?: GateScriptResult;
};

export type GateDecision = { readonly pass: true } | { readonly pass: false; readonly reason: string };

export function evaluateGate(inputs: GateInputs): GateDecision {
  if (inputs.gate.branch === "story" && inputs.storyId === undefined) {
    return { pass: false, reason: "gate: branch is not a story branch" };
  }
  if (inputs.gate.branch === "main" && inputs.branch !== "main") {
    return { pass: false, reason: "gate: branch is not main" };
  }

  if (inputs.gate.prdPasses === true) {
    if (inputs.storyId === undefined) return { pass: false, reason: "gate: prdPasses requires a story id" };
    if (inputs.passes === undefined) return { pass: false, reason: `gate: prdPasses is unavailable for ${inputs.storyId}` };
    if (!inputs.passes) return { pass: false, reason: `gate: prdPasses is false for ${inputs.storyId}` };
  }

  if (inputs.gate.phase !== undefined) {
    const currentPhase = inputs.phase ?? "building";
    if (comparePhase(currentPhase, inputs.gate.phase) < 0) {
      return { pass: false, reason: `gate: phase ${currentPhase} is before ${inputs.gate.phase}` };
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
