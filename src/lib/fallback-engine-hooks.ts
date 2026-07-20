import type { EngineFrontendHooks } from "../engine/engine-ports.ts";
import { createLoopState, subscribe, type LoopState } from "./state.ts";
import type { Step } from "./runner.ts";
import { divider, label, ui, waitWithCountdown } from "./fallback-ui.ts";

export function createFallbackEngineHooks(currentBranch: () => Promise<string>): EngineFrontendHooks<LoopState, Step> {
  let unsubscribe: (() => void) | undefined;
  return {
    createIterationState: ({ iteration, maxIterations, steps, branch }) => {
      const state = createLoopState({ maxIterations, stepNames: steps.map((step) => step.name) });
      state.iteration = iteration;
      state.branch = branch;
      state.iterationStartedAt = Date.now();
      return state;
    },
    onIterationStart: ({ state, iteration, maxIterations, steps, startStepIndex }) => {
      let printedLineCount = 0;
      unsubscribe = subscribe(() => {
        for (const line of state.agentLines.slice(printedLineCount)) process.stdout.write(`${line}\n`);
        printedLineCount = state.agentLines.length;
      });
      process.stdout.write(`\n${divider(`Iteration ${iteration}/${maxIterations}`, ui.cyan)}`);
      process.stdout.write(`${label("Branch", state.branch)}\n`);
      process.stdout.write(`${label("Step count", `${steps.length} at iteration start`)}\n`);
      if (startStepIndex > 0) process.stdout.write(`${label("Continuing", `from step ${startStepIndex + 1}/${steps.length}`)}\n`);
      process.stdout.write(`${ui.dim("│ list may change mid-iteration when looper.yaml changes")}\n`);
    },
    onStepBegin: ({ step, index, totalSteps }) => {
      process.stdout.write(`\n${divider(`Step ${index + 1}/${totalSteps} · ${step.name}`, ui.green)}`);
      process.stdout.write(`${label("Agent", step.agent || "default")}\n`);
      process.stdout.write(`${label("Model", step.model || "default")}\n`);
      process.stdout.write(`${label("Variant", step.variant === null ? "disabled" : step.variant || "default")}\n`);
      process.stdout.write(`${label("Prompt", step.prompt)}\n`);
    },
    onIterationComplete: async ({ iteration, maxIterations, elapsedSeconds }) => {
      unsubscribe?.();
      unsubscribe = undefined;
      process.stdout.write(`\n${ui.green("✓ iteration complete")} ${iteration}/${maxIterations} ${ui.dim("· branch")} ${await currentBranch()} ${ui.dim("·")} ${elapsedSeconds}s ${ui.dim("· continuing")}\n`);
    },
    onStopRequested: ({ iteration, phase }) => {
      unsubscribe?.();
      unsubscribe = undefined;
      process.stdout.write(phase === "before-iteration"
        ? `\n${ui.yellow("■ stop file exists")} stopping before iteration ${iteration}\n`
        : `\n${ui.yellow("■ stop requested")} stopping after iteration ${iteration}\n`);
    },
    onMaxIterationsReached: ({ maxIterations }) => {
      unsubscribe?.();
      unsubscribe = undefined;
      process.stdout.write(`\n${ui.yellow("■ max iterations reached")} ${maxIterations}; no .looper-stop found\n`);
    },
    waitBetweenIterations: async ({ state, seconds, label: waitLabel }) => {
      await waitWithCountdown(state, seconds, waitLabel, false);
    },
  };
}
