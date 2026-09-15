import type { LooperEvent } from "../../core/events.ts";
import { formatLooperEvent } from "../legacy-line-format.ts";

export type OutputBlock =
  | { kind: "lines"; lines: string[] }
  | { kind: "group"; title: string; borderColor: string; contentColor: string; lines: string[]; firstSeenAt: number }
  | { kind: "reasoning"; lines: string[]; firstSeenAt: number }
  | { kind: "looper"; lines: string[]; firstSeenAt: number }
  | { kind: "step-start"; firstSeenAt: number }
  | { kind: "step-finish"; summary: string; firstSeenAt: number }
  | { kind: "tool"; tool: string; callID?: string; callLine: string; status: "waiting" | "done" | "error"; outputLines: string[]; firstSeenAt: number };

type GroupBlock = Extract<OutputBlock, { kind: "group" }>;
type ReasoningBlock = Extract<OutputBlock, { kind: "reasoning" }>;
type LooperBlock = Extract<OutputBlock, { kind: "looper" }>;
type ToolBlock = Extract<OutputBlock, { kind: "tool" }>;

const ASSISTANT_COLORS = { borderColor: "#89dceb", contentColor: "#cdd6f4" } as const;
const USER_COLORS = { borderColor: "#f9e2af", contentColor: "#f9e2af" } as const;

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
  let pendingLines: string[] = [];
  let currentGroup: GroupBlock | undefined;
  let currentReasoning: ReasoningBlock | undefined;
  let currentLooper: LooperBlock | undefined;
  let currentTool: ToolBlock | undefined;
  let currentToolAlreadyRendered = false;
  const toolKey = (tool: string, callID?: string): string => callID === undefined ? `name:${tool}` : `id:${callID}`;

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
      const key = toolKey(currentTool.tool, currentTool.callID);
      const tools = pendingTools.get(key) ?? [];
      tools.push(currentTool);
      pendingTools.set(key, tools);
    }
    currentTool = undefined;
    currentToolAlreadyRendered = false;
  };
  const takePendingTool = (tool: string, callID?: string): { block: ToolBlock; alreadyRendered: boolean } | undefined => {
    const key = toolKey(tool, callID);
    if (currentTool !== undefined && currentTool.status === "waiting" && toolKey(currentTool.tool, currentTool.callID) === key) return { block: currentTool, alreadyRendered: currentToolAlreadyRendered };
    const tools = pendingTools.get(key);
    const pendingTool = tools?.pop();
    if (tools !== undefined && tools.length === 0) pendingTools.delete(key);
    if (pendingTool !== undefined) {
      return { block: pendingTool, alreadyRendered: true };
    }
    return undefined;
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
        if (currentGroup === undefined || currentGroup.title !== "Assistant") {
          flushGroup();
          currentGroup = { kind: "group", title: "Assistant", ...ASSISTANT_COLORS, lines: [], firstSeenAt };
        }
        currentGroup.lines.push(event.text);
        return;
      case "user.started":
        closeStructured();
        flushLines();
        currentGroup = { kind: "group", title: "User", ...USER_COLORS, lines: [], firstSeenAt };
        return;
      case "user.text":
        flushTool();
        flushReasoning();
        flushLines();
        if (currentGroup === undefined || currentGroup.title !== "User") {
          flushGroup();
          currentGroup = { kind: "group", title: "User", ...USER_COLORS, lines: [], firstSeenAt };
        }
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
        currentTool = { kind: "tool", tool: event.tool, ...(event.callID !== undefined ? { callID: event.callID } : {}), callLine: firstFormattedLine(event), status: "waiting", outputLines: [], firstSeenAt };
        currentToolAlreadyRendered = false;
        return;
      case "tool.done": {
        const pendingTool = takePendingTool(event.tool, event.callID);
        if (pendingTool !== undefined) {
          if (currentTool !== pendingTool.block) flushTool();
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
        blocks.push({
          kind: "tool",
          tool: event.tool,
          callLine: firstFormattedLine({ kind: "tool.started", tool: event.tool, input: {} }),
          status: "done",
          outputLines: toolOutputLines(event),
          firstSeenAt,
        });
        return;
      }
      case "tool.failed": {
        const pendingTool = takePendingTool(event.tool, event.callID);
        if (pendingTool !== undefined) {
          if (currentTool !== pendingTool.block) flushTool();
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
