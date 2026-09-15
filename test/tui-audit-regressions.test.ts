import { expect, test } from "bun:test";
import { clearAgentOutput, createLoopState, enterHistoryView, pushAgentLine, setHistoryViewEvents, setHistoryViewOutput, snapshotIterationToHistory, trimLoopStateMemory } from "../src/lib/state.ts";
import { createLoopStateStepReporter } from "../src/lib/loop-state-reporter.ts";
import { eventsToOutputBlocks } from "../src/presentation/tui/stream-blocks.ts";
import type { LooperEvent } from "../src/core/events.ts";

test("clears timestamp pairs between iterations", () => {
  const state = createLoopState({ maxIterations: 2, stepNames: ["build"] });
  for (let index = 0; index < 5000; index++) pushAgentLine(state, "old", index);
  clearAgentOutput(state);
  pushAgentLine(state, "new", 9999);
  trimLoopStateMemory(state);
  expect(state.agentLines).toEqual(["new"]);
  expect(state.agentLineTimes).toEqual([9999]);
});

test("matches same-name parallel tools by call identity", () => {
  const events: (LooperEvent & { callID?: string })[] = [
    { kind: "tool.started", tool: "read", callID: "a", input: { filePath: "a.ts" } },
    { kind: "tool.started", tool: "read", callID: "b", input: { filePath: "b.ts" } },
    { kind: "tool.done", tool: "read", callID: "a", output: "contents-a" },
    { kind: "tool.failed", tool: "read", callID: "b", error: "error-b" },
  ];
  const blocks = eventsToOutputBlocks(events, [1, 2, 3, 4]);
  expect(blocks.find((block) => block.kind === "tool" && block.callID === "a")).toMatchObject({ callLine: expect.stringContaining("a.ts"), status: "done", outputLines: ["contents-a"] });
  expect(blocks.find((block) => block.kind === "tool" && block.callID === "b")).toMatchObject({ callLine: expect.stringContaining("b.ts"), status: "error" });
});

test("preserves parallel tool inputs when another tool completes first", () => {
  // Given
  const events: LooperEvent[] = [
    { kind: "tool.started", tool: "bash", input: { command: "pwd" } },
    { kind: "tool.started", tool: "read", input: { filePath: "file.ts" } },
    { kind: "tool.done", tool: "bash", output: "cwd" },
    { kind: "tool.done", tool: "read", output: "contents" },
  ];
  // When
  const blocks = eventsToOutputBlocks(events, [1, 2, 3, 4]);
  // Then
  const read = blocks.find((block) => block.kind === "tool" && block.tool === "read");
  expect(read).toMatchObject({ callLine: expect.stringContaining("file.ts"), outputLines: ["contents"] });
});

test("keeps unmatched completion away from a different pending tool", () => {
  // Given
  const events: LooperEvent[] = [
    { kind: "tool.started", tool: "bash", input: { command: "pwd" } },
    { kind: "assistant.text", text: "waiting" },
    { kind: "tool.done", tool: "read", output: "contents" },
  ];
  // When
  const blocks = eventsToOutputBlocks(events, []);
  // Then
  expect(blocks.find((block) => block.kind === "tool" && block.tool === "bash")).toMatchObject({ status: "waiting", outputLines: [] });
});

test("bounds restored session events and formatted lines", () => {
  // Given
  const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
  const events: LooperEvent[] = Array.from({ length: 100_001 }, (_, index) => ({ kind: "assistant.text", text: String(index) }));
  // When
  createLoopStateStepReporter(state).out.replaceSession(0, { events, eventTimes: events.map((_, index) => index) });
  // Then
  expect(state.steps[0]?.outputEvents).toHaveLength(5000);
  expect(state.steps[0]?.outputLines).toHaveLength(5000);
  expect(state.steps[0]?.outputEventTimes?.[0]).toBe(95_001);
});

test("bounds history restoration and keeps timestamp pairs", () => {
  // Given
  const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
  state.iteration = 1;
  const step = state.steps[0];
  if (step === undefined) throw new Error("missing fixture step");
  step.sessionID = "session";
  snapshotIterationToHistory(state);
  enterHistoryView(state);
  const lines = Array.from({ length: 5001 }, (_, index) => String(index));
  // When
  setHistoryViewOutput(state, "0:0:session", lines, lines.map(Number));
  setHistoryViewEvents(state, "0:0:session", lines.map((text) => ({ kind: "assistant.text", text })), lines.map(Number));
  // Then
  expect(state.historyView?.lines).toHaveLength(5000);
  expect(state.historyView?.events).toHaveLength(5000);
  expect(state.historyView?.lineTimes[0]).toBe(1);
  expect(state.historyView?.eventTimes[0]).toBe(1);
  expect(state.historyView?.outputScrollTop).toBe(4999);
});
