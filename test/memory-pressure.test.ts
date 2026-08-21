import { afterEach, describe, expect, test } from "bun:test";

import { installMemoryPressureTrimmer } from "../src/lib/memory-pressure.ts";
import {
  AGENT_MAX_LINES,
  createBackgroundAgent,
  createLoopState,
  enterHistoryView,
  HISTORY_MAX_ENTRIES,
  snapshotIterationToHistory,
  trimLoopStateMemory,
  type LoopState,
} from "../src/lib/state.ts";

const OVERFLOW = 3;

type MemoryPressureLevel = "warning" | "critical";

function emitMemoryPressure(level: MemoryPressureLevel): boolean {
  return process.emit("memoryPressure", level);
}

function fillPairedLines(lines: string[], times: number[], count: number, prefix: string): void {
  for (let i = 0; i < count; i += 1) {
    lines.push(`${prefix}-${i}`);
    times.push(i);
  }
}

function dummyHistoryEntry(iteration: number): LoopState["history"][number] {
  return { iteration, branch: "main", startedAt: iteration, steps: [] };
}

function overfillState(state: LoopState): void {
  fillPairedLines(state.agentLines, state.agentLineTimes, AGENT_MAX_LINES + OVERFLOW, "agent");

  const step = state.steps[0];
  if (step === undefined) throw new Error("expected step 0");
  fillPairedLines(step.outputLines, step.outputLineTimes, AGENT_MAX_LINES + OVERFLOW, "step");

  const agent = createBackgroundAgent("ses_bg", 1);
  fillPairedLines(agent.outputLines, agent.outputLineTimes, AGENT_MAX_LINES + OVERFLOW, "bg");
  step.backgroundAgents.push(agent);

  for (let i = 1; i <= HISTORY_MAX_ENTRIES + OVERFLOW; i += 1) {
    state.history.push(dummyHistoryEntry(i));
  }
}

let detachTrimmer: (() => void) | undefined;

afterEach(() => {
  detachTrimmer?.();
  detachTrimmer = undefined;
});

describe("trimLoopStateMemory", () => {
  test("is a no-op when every buffer is under its cap", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    fillPairedLines(state.agentLines, state.agentLineTimes, 4, "agent");
    const step = state.steps[0];
    if (step === undefined) throw new Error("expected step 0");
    fillPairedLines(step.outputLines, step.outputLineTimes, 2, "step");
    state.history.push(dummyHistoryEntry(1));

    trimLoopStateMemory(state);

    expect(state.agentLines).toEqual(["agent-0", "agent-1", "agent-2", "agent-3"]);
    expect(state.agentLineTimes).toEqual([0, 1, 2, 3]);
    expect(step.outputLines).toEqual(["step-0", "step-1"]);
    expect(state.history).toHaveLength(1);
  });

  test("caps overfull agent, step, background, and history buffers; a second call is a no-op", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    overfillState(state);
    const step = state.steps[0];
    const agent = step?.backgroundAgents[0];
    if (step === undefined || agent === undefined) throw new Error("expected overfilled step agent");

    trimLoopStateMemory(state);

    expect(state.agentLines).toHaveLength(AGENT_MAX_LINES);
    expect(state.agentLines[0]).toBe("agent-3");
    expect(state.agentLineTimes).toHaveLength(AGENT_MAX_LINES);
    expect(state.agentLineTimes[0]).toBe(3);
    expect(step.outputLines).toHaveLength(AGENT_MAX_LINES);
    expect(step.outputLines[0]).toBe("step-3");
    expect(agent.outputLines).toHaveLength(AGENT_MAX_LINES);
    expect(agent.outputLines[0]).toBe("bg-3");
    expect(state.history).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(state.history[0]?.iteration).toBe(4);

    const agentHead = state.agentLines[0];
    const stepHead = step.outputLines[0];
    const bgHead = agent.outputLines[0];
    const historyHead = state.history[0]?.iteration;
    trimLoopStateMemory(state);
    expect(state.agentLines[0]).toBe(agentHead);
    expect(step.outputLines[0]).toBe(stepHead);
    expect(agent.outputLines[0]).toBe(bgHead);
    expect(state.history[0]?.iteration).toBe(historyHead);
    expect(state.agentLines).toHaveLength(AGENT_MAX_LINES);
    expect(state.history).toHaveLength(HISTORY_MAX_ENTRIES);
  });

  test("does not throw when a step has no outputEvents", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    const step = state.steps[0];
    if (step === undefined) throw new Error("expected step 0");
    delete step.outputEvents;
    delete step.outputEventTimes;
    const agent = createBackgroundAgent("ses_bg", 1);
    delete agent.outputEvents;
    delete agent.outputEventTimes;
    step.backgroundAgents.push(agent);

    expect(() => {
      trimLoopStateMemory(state);
    }).not.toThrow();
  });
});

describe("installMemoryPressureTrimmer", () => {
  test("trims on a critical memoryPressure emit", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    detachTrimmer = installMemoryPressureTrimmer(() => state);
    fillPairedLines(state.agentLines, state.agentLineTimes, AGENT_MAX_LINES + OVERFLOW, "agent");

    emitMemoryPressure("critical");

    expect(state.agentLines).toHaveLength(AGENT_MAX_LINES);
    expect(state.agentLines[0]).toBe("agent-3");
  });

  test("trims on a warning memoryPressure emit", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    detachTrimmer = installMemoryPressureTrimmer(() => state);
    fillPairedLines(state.agentLines, state.agentLineTimes, AGENT_MAX_LINES + OVERFLOW, "agent");

    emitMemoryPressure("warning");

    expect(state.agentLines).toHaveLength(AGENT_MAX_LINES);
    expect(state.agentLines[0]).toBe("agent-3");
  });

  test("does not throw when the getter returns null", () => {
    detachTrimmer = installMemoryPressureTrimmer(() => null);

    expect(() => {
      emitMemoryPressure("critical");
    }).not.toThrow();
  });

  test("does not throw when the getter throws", () => {
    detachTrimmer = installMemoryPressureTrimmer(() => {
      throw new Error("getter failed");
    });

    expect(() => {
      emitMemoryPressure("critical");
    }).not.toThrow();
  });

  test("does not trim after detach", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    const detach = installMemoryPressureTrimmer(() => state);
    fillPairedLines(state.agentLines, state.agentLineTimes, AGENT_MAX_LINES + OVERFLOW, "agent");
    detach();

    emitMemoryPressure("critical");

    expect(state.agentLines).toHaveLength(AGENT_MAX_LINES + OVERFLOW);
  });
});

describe("trimLoopStateMemory history view", () => {
  test("trims historyView line and event buffers when present", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    state.iteration = 1;
    snapshotIterationToHistory(state);
    expect(enterHistoryView(state)).toBe(true);
    const view = state.historyView;
    if (view === null) throw new Error("expected history view");
    fillPairedLines(view.lines, view.lineTimes, AGENT_MAX_LINES + OVERFLOW, "hist");
    for (let i = 0; i < AGENT_MAX_LINES + OVERFLOW; i += 1) {
      view.events.push({ kind: "looper.log", message: `e-${i}` });
      view.eventTimes.push(i);
    }

    trimLoopStateMemory(state);

    expect(view.lines).toHaveLength(AGENT_MAX_LINES);
    expect(view.lines[0]).toBe("hist-3");
    expect(view.events).toHaveLength(AGENT_MAX_LINES);
    expect(view.eventTimes).toHaveLength(AGENT_MAX_LINES);
  });
});
