import type { LooperEvent } from "../../core/events.ts";
import { formatLooperEvent } from "../legacy-line-format.ts";

export type OutputBlock =
  | { kind: "lines"; lines: string[] }
  | { kind: "group"; title: string; borderColor: string; contentColor: string; lines: string[]; firstSeenAt: number }
  | { kind: "reasoning"; lines: string[]; firstSeenAt: number }
  | { kind: "looper"; lines: string[]; firstSeenAt: number }
  | { kind: "step-start"; firstSeenAt: number }
  | { kind: "step-finish"; summary: string; firstSeenAt: number }
  | { kind: "tool"; tool: string; callLine: string; status: "waiting" | "done" | "error"; outputLines: string[]; firstSeenAt: number };

type GroupBlock = Extract<OutputBlock, { kind: "group" }>;
type ReasoningBlock = Extract<OutputBlock, { kind: "reasoning" }>;
type LooperBlock = Extract<OutputBlock, { kind: "looper" }>;
type ToolBlock = Extract<OutputBlock, { kind: "tool" }>;

const ASSISTANT_COLORS = { borderColor: "#89dceb", contentColor: "#cdd6f4" } as const;

function assertNever(value: never): never {
  throw new Error(`Unexpected LooperEvent: ${JSON.stringify(value)}`);
}

function firstFormattedLine(event: LooperEvent): string {
  return formatLooperEvent(event)[0] ?? "";
}

function toolOutputLines(event: Extract<LooperEvent, { kind: "tool.done" }>): string[] {
  const lines = event.output
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
  const visible = lines.length === 0 ? ["(no output)"] : lines;
  return event.retainedOutputPath === undefined ? visible : [...visible, `retained full output: ${event.retainedOutputPath}`];
}

export function eventsToOutputBlocks(events: readonly LooperEvent[], times: readonly number[]): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  const pendingTools = new Map<string, ToolBlock[]>();
  const pendingToolOrder: ToolBlock[] = [];
  let pendingLines: string[] = [];
  let currentGroup: GroupBlock | undefined;
  let currentReasoning: ReasoningBlock | undefined;
  let currentLooper: LooperBlock | undefined;
  let currentTool: ToolBlock | undefined;
  let currentToolAlreadyRendered = false;

  const timeAt = (index: number): number => times[index] ?? Date.now();
  const flushLines = (): void => {
    if (pendingLines.length === 0) return;
    blocks.push({ kind: "lines", lines: pendingLines });
    pendingLines = [];
  };
  const flushGroup = (): void => {
    if (currentGroup === undefined) return;
    blocks.push(currentGroup);
    currentGroup = undefined;
  };
  const flushReasoning = (): void => {
    if (currentReasoning === undefined) return;
    blocks.push(currentReasoning);
    currentReasoning = undefined;
  };
  const flushLooper = (): void => {
    if (currentLooper === undefined) return;
    blocks.push(currentLooper);
    currentLooper = undefined;
  };
  const flushTool = (): void => {
    if (currentTool === undefined) return;
    if (!currentToolAlreadyRendered) blocks.push(currentTool);
    if (!currentToolAlreadyRendered && currentTool.status === "waiting") {
      const tools = pendingTools.get(currentTool.tool) ?? [];
      tools.push(currentTool);
      pendingTools.set(currentTool.tool, tools);
      pendingToolOrder.push(currentTool);
    }
    currentTool = undefined;
    currentToolAlreadyRendered = false;
  };
  const removePendingTool = (tool: ToolBlock): void => {
    const orderedIndex = pendingToolOrder.lastIndexOf(tool);
    if (orderedIndex !== -1) pendingToolOrder.splice(orderedIndex, 1);
    const tools = pendingTools.get(tool.tool);
    if (tools === undefined) return;
    const namedIndex = tools.lastIndexOf(tool);
    if (namedIndex !== -1) tools.splice(namedIndex, 1);
    if (tools.length === 0) pendingTools.delete(tool.tool);
  };
  const takePendingTool = (tool: string): { block: ToolBlock; alreadyRendered: boolean } | undefined => {
    if (currentTool !== undefined && currentTool.tool === tool) return { block: currentTool, alreadyRendered: currentToolAlreadyRendered };
    const tools = pendingTools.get(tool);
    const pendingTool = tools?.pop();
    if (tools !== undefined && tools.length === 0) pendingTools.delete(tool);
    if (pendingTool !== undefined) {
      const orderedIndex = pendingToolOrder.lastIndexOf(pendingTool);
      if (orderedIndex !== -1) pendingToolOrder.splice(orderedIndex, 1);
      return { block: pendingTool, alreadyRendered: true };
    }
    const fallbackTool = pendingToolOrder.pop();
    if (fallbackTool === undefined) return undefined;
    removePendingTool(fallbackTool);
    return { block: fallbackTool, alreadyRendered: true };
  };
  const closeStructured = (): void => {
    flushTool();
    flushReasoning();
    flushGroup();
  };
  const pushLineEvent = (line: string): void => {
    closeStructured();
    pendingLines.push(line);
  };

  events.forEach((event, index) => {
    const firstSeenAt = timeAt(index);
    if (event.kind !== "looper.log" && event.kind !== "continuation.notice") flushLooper();
    switch (event.kind) {
      case "step.started":
        closeStructured();
        flushLines();
        blocks.push({ kind: "step-start", firstSeenAt });
        return;
      case "step.done":
        closeStructured();
        flushLines();
        blocks.push({ kind: "step-finish", summary: firstFormattedLine(event), firstSeenAt });
        return;
      case "assistant.started":
        closeStructured();
        flushLines();
        currentGroup = { kind: "group", title: "Assistant", ...ASSISTANT_COLORS, lines: [], firstSeenAt };
        return;
      case "assistant.text":
        flushTool();
        flushReasoning();
        flushLines();
        if (currentGroup === undefined) currentGroup = { kind: "group", title: "Assistant", ...ASSISTANT_COLORS, lines: [], firstSeenAt };
        currentGroup.lines.push(event.text);
        return;
      case "reasoning.started":
        flushTool();
        flushGroup();
        flushLines();
        currentReasoning = { kind: "reasoning", lines: [], firstSeenAt };
        return;
      case "reasoning.text":
        flushTool();
        flushGroup();
        flushLines();
        if (currentReasoning === undefined) currentReasoning = { kind: "reasoning", lines: [], firstSeenAt };
        currentReasoning.lines.push(event.text);
        return;
      case "tool.started":
        flushReasoning();
        flushGroup();
        flushTool();
        flushLines();
        currentTool = { kind: "tool", tool: event.tool, callLine: firstFormattedLine(event), status: "waiting", outputLines: [], firstSeenAt };
        currentToolAlreadyRendered = false;
        return;
      case "tool.done": {
        const pendingTool = takePendingTool(event.tool);
        if (pendingTool !== undefined) {
          pendingTool.block.status = "done";
          pendingTool.block.outputLines.push(...toolOutputLines(event));
          currentTool = pendingTool.block;
          currentToolAlreadyRendered = pendingTool.alreadyRendered;
          flushReasoning();
          flushGroup();
          flushLines();
          return;
        }
        closeStructured();
        flushLines();
        blocks.push({ kind: "group", title: `Tool output · ${event.tool}`, borderColor: "#a6e3a1", contentColor: "#cdd6f4", lines: toolOutputLines(event), firstSeenAt });
        return;
      }
      case "tool.failed": {
        const pendingTool = takePendingTool(event.tool);
        if (pendingTool !== undefined) {
          pendingTool.block.status = "error";
          pendingTool.block.outputLines.push(firstFormattedLine(event));
          currentTool = pendingTool.block;
          currentToolAlreadyRendered = pendingTool.alreadyRendered;
          return;
        }
        pushLineEvent(firstFormattedLine(event));
        return;
      }
      case "looper.log":
      case "continuation.notice":
        closeStructured();
        flushLines();
        if (currentLooper === undefined) currentLooper = { kind: "looper", lines: [], firstSeenAt };
        currentLooper.lines.push(firstFormattedLine(event));
        return;
      case "step.failed":
      case "assistant.error":
      case "assistant.aborted":
      case "session.error":
      case "retry":
      case "debug.event":
      case "looper.error":
        pushLineEvent(firstFormattedLine(event));
        return;
      default:
        return assertNever(event);
    }
  });

  flushTool();
  flushReasoning();
  flushLooper();
  flushGroup();
  flushLines();
  return blocks;
}
