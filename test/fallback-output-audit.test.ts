import { expect, spyOn, test } from "bun:test";
import { createFallbackEngineHooks } from "../src/lib/fallback-engine-hooks.ts";
import { createRunControl } from "../src/engine/run-control.ts";
import { createLoopState, notify, pushAgentLine, subscribe, subscribeAgentLines } from "../src/lib/state.ts";

test("delivers output beyond retention and drains the last line on completion", async () => {
  // Given
  const output: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  const hooks = createFallbackEngineHooks(async () => "main", createRunControl());
  const input = { iteration: 1, maxIterations: 1, steps: [], branch: "main" };
  const state = hooks.createIterationState(input);
  try {
    await hooks.onIterationStart?.({ ...input, state, startStepIndex: 0, resumedPriorSteps: false });
    for (let index = 0; index < 5001; index++) pushAgentLine(state, `line-${index}`);
    // When: no debounced notify has fired before completion.
    await hooks.onIterationComplete?.({ state, iteration: 1, maxIterations: 1, elapsedSeconds: 0 });
    // Then
    expect(output).toContain("line-5000\n");
    expect(output.filter((line) => line.startsWith("line-"))).toHaveLength(5001);
  } finally {
    write.mockRestore();
  }
});

test("prints the next line after the retained buffer is already full", async () => {
  const state = createLoopState({ maxIterations: 1, stepNames: [] });
  const output: string[] = [];
  const dispose = subscribeAgentLines(state, (line) => { output.push(line); });
  try {
    for (let index = 0; index < 5000; index++) pushAgentLine(state, String(index));
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribe(() => { unsubscribe(); resolve(); });
      notify();
    });
    pushAgentLine(state, "after-cap");
  } finally {
    dispose();
  }
  expect(output).toHaveLength(5001);
  expect(output.at(-1)).toBe("after-cap");
  expect(state.agentLines).toHaveLength(5000);
});

test("exceptional disposal drains output without a completion hook", async () => {
  const output: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  try {
    using hooks = createFallbackEngineHooks(async () => "main", createRunControl());
    const input = { iteration: 1, maxIterations: 1, steps: [], branch: "main" };
    const state = hooks.createIterationState(input);
    await hooks.onIterationStart?.({ ...input, state, startStepIndex: 0, resumedPriorSteps: false });
    pushAgentLine(state, "last-on-error");
  } finally {
    write.mockRestore();
  }
  expect(output).toContain("last-on-error\n");
});
