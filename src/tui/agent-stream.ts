import {
  BoxRenderable,
  LayoutEvents,
  RenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";

import type { BackgroundAgent, LoopState, LoopStep } from "../lib/state.ts";
import { ansiToStyledText, stripAnsi } from "../lib/ansi.ts";
import { backgroundAgentLabel, consumeScrollIntent, setSelectedStepOutputScroll, subscribe } from "../lib/state.ts";

type SelectedOutput = {
  step: LoopStep | null;
  stepIndex: number | null;
  backgroundAgent: BackgroundAgent | null;
  lines: string[];
  times: number[];
};

type OutputBlock =
  | { kind: "lines"; lines: string[] }
  | { kind: "group"; title: string; borderColor: string; contentColor: string; lines: string[]; firstSeenAt: number }
  | { kind: "reasoning"; lines: string[]; firstSeenAt: number }
  | { kind: "tool"; tool: string; callLine: string; status: "waiting" | "done" | "error"; outputLines: string[]; firstSeenAt: number };

type ToolBlock = Extract<OutputBlock, { kind: "tool" }>;

type OutputRenderable = BoxRenderable | TextRenderable;

const GROUP_LINE_PREFIX = /^(?:\u001B\[[0-9;]*m)*│(?:\u001B\[[0-9;]*m)* ?/;

function headerTitle(line: string): string | null {
  const visible = stripAnsi(line);
  if (!visible.startsWith("╭─ ")) return null;
  return visible.slice(3).replace(/\s*(?:─+\s*)?\d{1,2}:\d{2}\s[ap]m$/, "").trim();
}

function headerColors(line: string, title: string): { borderColor: string; contentColor: string } {
  if (line.includes("\u001b[32m") || title.startsWith("Tool output")) return { borderColor: "#a6e3a1", contentColor: "#cdd6f4" };
  if (line.includes("\u001b[33m")) return { borderColor: "#f9e2af", contentColor: "#cdd6f4" };
  if (line.includes("\u001b[31m")) return { borderColor: "#f38ba8", contentColor: "#cdd6f4" };
  return { borderColor: "#89dceb", contentColor: "#cdd6f4" };
}

function groupContentLine(line: string): string {
  if (GROUP_LINE_PREFIX.test(line)) return line.replace(GROUP_LINE_PREFIX, "");

  const visible = stripAnsi(line);
  if (visible.startsWith("│ ")) return visible.slice(2);

  return line;
}

function toolCallName(line: string): string | null {
  const visible = stripAnsi(line);
  if (!visible.startsWith("◌ tool ")) return null;
  return visible.slice("◌ tool ".length).split(" ")[0] ?? null;
}

function toolOutputName(title: string): string | null {
  if (!title.startsWith("Tool output · ")) return null;
  return title.slice("Tool output · ".length).trim() || null;
}

function toolFailureName(line: string): string | null {
  const visible = stripAnsi(line);
  if (!visible.startsWith("✗ tool failed ")) return null;
  return visible.slice("✗ tool failed ".length).split(" ")[0] ?? null;
}

function isStandaloneStatusLine(line: string): boolean {
  const visible = stripAnsi(line);
  return (
    visible.startsWith("◌ tool") ||
    visible.startsWith("✓ step done") ||
    visible.startsWith("✗ tool failed") ||
    visible.startsWith("✗ session error") ||
    visible.startsWith("↻ retry") ||
    visible.startsWith("[loop]")
  );
}

function parseOutputBlocks(lines: string[], times: number[]): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  const pendingTools = new Map<string, ToolBlock[]>();
  const pendingToolOrder: ToolBlock[] = [];
  let pendingLines: string[] = [];
  let currentGroup: Extract<OutputBlock, { kind: "group" }> | undefined;
  let currentReasoning: Extract<OutputBlock, { kind: "reasoning" }> | undefined;
  let currentTool: ToolBlock | undefined;
  let currentToolAlreadyRendered = false;
  const timeAt = (index: number): number => times[index] ?? Date.now();

  const flushLines = () => {
    if (pendingLines.length === 0) return;
    blocks.push({ kind: "lines", lines: pendingLines });
    pendingLines = [];
  };

  const flushGroup = () => {
    if (currentGroup === undefined) return;
    blocks.push(currentGroup);
    currentGroup = undefined;
  };

  const flushReasoning = () => {
    if (currentReasoning === undefined) return;
    blocks.push(currentReasoning);
    currentReasoning = undefined;
  };

  const flushTool = () => {
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

  const takePendingTool = (tool: string | null): { block: ToolBlock; alreadyRendered: boolean } | undefined => {
    if (tool !== null && currentTool !== undefined && currentTool.tool === tool) return { block: currentTool, alreadyRendered: currentToolAlreadyRendered };
    const requestedTool = tool;
    const tools = requestedTool === null ? undefined : pendingTools.get(requestedTool);
    const pendingTool = tools?.pop();
    if (requestedTool !== null && tools !== undefined && tools.length === 0) pendingTools.delete(requestedTool);
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

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const title = headerTitle(line);
    const toolName = toolCallName(line);

    if (toolName !== null) {
      flushReasoning();
      flushGroup();
      flushTool();
      flushLines();
      currentTool = { kind: "tool", tool: toolName, callLine: line, status: "waiting", outputLines: [], firstSeenAt: timeAt(lineIndex) };
      currentToolAlreadyRendered = false;
      continue;
    }

    if (title !== null) {
      const outputToolName = toolOutputName(title);
      if (outputToolName !== null) {
        const pendingTool = takePendingTool(outputToolName);
        if (pendingTool !== undefined) {
          pendingTool.block.status = "done";
          currentTool = pendingTool.block;
          currentToolAlreadyRendered = pendingTool.alreadyRendered;
          flushReasoning();
          flushGroup();
          flushLines();
          continue;
        }
      }

      if (outputToolName !== null && currentTool !== undefined && outputToolName === currentTool.tool) {
        currentTool.status = "done";
        continue;
      }

      flushTool();
      flushReasoning();
      flushGroup();
      flushLines();
      if (title === "Reasoning") {
        currentReasoning = { kind: "reasoning", lines: [], firstSeenAt: timeAt(lineIndex) };
        continue;
      }
      currentGroup = { kind: "group", title, ...headerColors(line, title), lines: [], firstSeenAt: timeAt(lineIndex) };
      continue;
    }

    const failedToolName = toolFailureName(line);
    if (failedToolName !== null) {
      const pendingTool = takePendingTool(failedToolName);
      if (pendingTool !== undefined) {
        pendingTool.block.status = "error";
        pendingTool.block.outputLines.push(line);
        currentTool = pendingTool.block;
        currentToolAlreadyRendered = pendingTool.alreadyRendered;
        continue;
      }
    }

    if (currentGroup !== undefined && isStandaloneStatusLine(line)) {
      flushGroup();
    }

    if (currentTool !== undefined && isStandaloneStatusLine(line)) {
      flushTool();
    }

    if (currentReasoning !== undefined && isStandaloneStatusLine(line)) {
      flushReasoning();
    }

    if (currentTool !== undefined && currentTool.status !== "waiting") currentTool.outputLines.push(groupContentLine(line));
    else if (currentReasoning !== undefined) currentReasoning.lines.push(groupContentLine(line));
    else if (currentGroup !== undefined) currentGroup.lines.push(groupContentLine(line));
    else pendingLines.push(line);
  }

  flushTool();
  flushReasoning();
  flushGroup();
  flushLines();

  return blocks;
}

function createTextBlock(renderer: CliRenderer, id: string, lines: string[], color = "#cdd6f4"): TextRenderable {
  return new TextRenderable(renderer, {
    id,
    width: "100%",
    minWidth: 0,
    alignSelf: "stretch",
    wrapMode: "word",
    truncate: false,
    content: ansiToStyledText(lines.join("\n")),
    fg: color,
  });
}

function createGroupBlock(renderer: CliRenderer, id: string, block: Extract<OutputBlock, { kind: "group" }>): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    id,
    width: "100%",
    minWidth: 0,
    alignSelf: "stretch",
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: block.borderColor,
    title: block.title,
    titleAlignment: "left",
    bottomTitle: formatTimestamp(block.firstSeenAt),
    bottomTitleAlignment: "right",
    paddingX: 1,
    marginBottom: 1,
  });

  if (block.lines.length > 0) box.add(createTextBlock(renderer, `${id}-body`, block.lines, block.contentColor));

  return box;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function createReasoningBlock(renderer: CliRenderer, id: string, block: Extract<OutputBlock, { kind: "reasoning" }>): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    id,
    width: "100%",
    minWidth: 0,
    alignSelf: "stretch",
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: "#6c7086",
    title: "Reasoning",
    titleAlignment: "left",
    bottomTitle: formatTimestamp(block.firstSeenAt),
    bottomTitleAlignment: "right",
    paddingX: 1,
    marginBottom: 1,
  });
  if (block.lines.length > 0) box.add(createTextBlock(renderer, `${id}-body`, block.lines, "#6c7086"));
  return box;
}

function createToolBlock(renderer: CliRenderer, id: string, block: Extract<OutputBlock, { kind: "tool" }>): BoxRenderable {
  const borderColor = block.status === "waiting" ? "#f9e2af" : block.status === "error" ? "#f38ba8" : "#a6e3a1";
  const statusText = block.status === "waiting" ? "waiting" : block.status === "error" ? "failed" : "done";
  const box = new BoxRenderable(renderer, {
    id,
    width: "100%",
    minWidth: 0,
    alignSelf: "stretch",
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor,
    title: `Tool · ${block.tool} · ${statusText}`,
    titleAlignment: "left",
    bottomTitle: formatTimestamp(block.firstSeenAt),
    bottomTitleAlignment: "right",
    paddingX: 1,
    marginBottom: 1,
  });

  box.add(createTextBlock(renderer, `${id}-call`, [block.callLine], "#f9e2af"));

  if (block.status === "waiting") {
    box.add(createTextBlock(renderer, `${id}-waiting`, ["⏳ waiting for response…"], "#6c7086"));
  } else {
    box.add(createTextBlock(renderer, `${id}-response`, block.outputLines.length > 0 ? block.outputLines : ["(no output)"], block.status === "error" ? "#f38ba8" : "#cdd6f4"));
  }

  return box;
}

function fallbackTitle(state: LoopState): string {
  const activeStep = state.activeStepIndex === null ? undefined : state.steps[state.activeStepIndex];
  return activeStep ? `${activeStep.name} output` : "Agent output";
}

function resolveSelectedOutput(state: LoopState): SelectedOutput {
  const candidateStepIndexes = [state.selectedStepIndex, state.activeStepIndex, state.steps.length > 0 ? 0 : null];

  for (const candidateStepIndex of candidateStepIndexes) {
    if (candidateStepIndex === null) continue;
    const step = state.steps[candidateStepIndex];
    if (!step) continue;
    if (
      candidateStepIndex === state.selectedStepIndex &&
      state.selectedBackgroundSessionID !== null
    ) {
      const agent = step.backgroundAgents.find(
        (candidate) => candidate.sessionID === state.selectedBackgroundSessionID,
      );
      if (agent) {
        return {
          step,
          stepIndex: candidateStepIndex,
          backgroundAgent: agent,
          lines: agent.outputLines,
          times: agent.outputLineTimes,
        };
      }
    }
    return {
      step,
      stepIndex: candidateStepIndex,
      backgroundAgent: null,
      lines: step.outputLines,
      times: step.outputLineTimes,
    };
  }

  return {
    step: null,
    stepIndex: null,
    backgroundAgent: null,
    lines: state.agentLines,
    times: state.agentLineTimes,
  };
}

function outputTitle(state: LoopState, selectedOutput: SelectedOutput): string {
  if (!selectedOutput.step || selectedOutput.stepIndex === null) return fallbackTitle(state);
  const { name, title } = selectedOutput.step;
  const stepLabel = title && title.length > 0 ? `${name}: ${title}` : `${name} output`;
  if (selectedOutput.backgroundAgent === null) return stepLabel;
  return `${stepLabel} · bg: ${backgroundAgentLabel(selectedOutput.backgroundAgent)}`;
}

/** Pixels from the bottom within which we still treat the view as "at bottom" for follow mode. */
const BOTTOM_SLACK = 2;

export function createAgentStream(renderer: CliRenderer, state: LoopState): ScrollBoxRenderable {
  const initialOutput = resolveSelectedOutput(state);
  const stream = new ScrollBoxRenderable(renderer, {
    id: "loop-agent-stream",
    width: "100%",
    height: "100%",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#45475a",
    title: outputTitle(state, initialOutput),
    paddingX: 1,
    scrollY: true,
    scrollX: false,
    // OpenTUI's sticky scroll + wheel handling sets _hasManualScroll on every scroll event while
    // content is scrollable, so follow-on-output breaks. We pin to the bottom ourselves instead.
    stickyScroll: false,
    contentOptions: {
      flexDirection: "column",
      alignItems: "stretch",
      width: "100%",
      // ScrollBox defaults scrollY content to minHeight 100%, which leaves empty space below the
      // last line when scrolled to the end.
      minHeight: "auto",
    },
  });

  let outputRenderables: OutputRenderable[] = [];

  const replaceOutput = (lines: string[], times: number[]) => {
    for (const renderable of outputRenderables) {
      stream.content.remove(renderable.id);
      renderable.destroyRecursively();
    }

    outputRenderables = [];

    const sourceLines = lines.length > 0 ? lines : ["No output yet."];
    const sourceTimes = lines.length > 0 ? times : [Date.now()];
    const blocks = parseOutputBlocks(sourceLines, sourceTimes);
    blocks.forEach((block, index) => {
      let renderable: OutputRenderable;
      if (block.kind === "group") {
        renderable = createGroupBlock(renderer, `loop-agent-group-${index}`, block);
      } else if (block.kind === "reasoning") {
        renderable = createReasoningBlock(renderer, `loop-agent-reasoning-${index}`, block);
      } else if (block.kind === "tool") {
        renderable = createToolBlock(renderer, `loop-agent-tool-${index}`, block);
      } else {
        renderable = createTextBlock(renderer, `loop-agent-lines-${index}`, block.lines);
      }
      outputRenderables.push(renderable);
      stream.content.add(renderable);
    });
  };

  let selectedOutput = initialOutput;
  let selectedStepIndex = initialOutput.stepIndex;
  let selectedBackgroundSessionID = initialOutput.backgroundAgent?.sessionID ?? null;
  let renderedOutputKey: string | undefined;
  let pinToBottom = (initialOutput.backgroundAgent ?? initialOutput.step)?.outputPinnedToBottom ?? true;
  let syncingStateScroll = false;

  const outputKey = (output: SelectedOutput): string => {
    const stepKey = output.stepIndex ?? "agent";
    const bgKey = output.backgroundAgent?.sessionID ?? "step";
    return `${stepKey}:${bgKey}:${output.lines.length}:${output.lines[0] ?? ""}:${output.lines.at(-1) ?? ""}`;
  };

  const selectedScrollTarget = (): { outputScrollTop: number; outputPinnedToBottom: boolean } | null =>
    selectedOutput.backgroundAgent ?? selectedOutput.step;

  const maxScrollTop = (): number => Math.max(0, stream.scrollHeight - stream.viewport.height);

  const persistSelectedScroll = (scrollTop: number, pinnedToBottom: boolean): void => {
    const target = selectedScrollTarget();
    if (target === null || selectedOutput.stepIndex === null) return;
    if (target.outputScrollTop === scrollTop && target.outputPinnedToBottom === pinnedToBottom) return;
    const stillSelected =
      selectedOutput.stepIndex === state.selectedStepIndex &&
      (selectedOutput.backgroundAgent?.sessionID ?? null) === state.selectedBackgroundSessionID;
    if (!stillSelected) {
      target.outputScrollTop = scrollTop;
      target.outputPinnedToBottom = pinnedToBottom;
      return;
    }
    syncingStateScroll = true;
    setSelectedStepOutputScroll(state, scrollTop, pinnedToBottom);
    syncingStateScroll = false;
  };

  const syncPinFromScrollPosition = (): void => {
    const max = maxScrollTop();
    pinToBottom = max <= 0 || stream.scrollTop >= max - BOTTOM_SLACK;
    persistSelectedScroll(stream.scrollTop, pinToBottom);
  };

  const scrollToBottomIfPinned = (): void => {
    if (!pinToBottom) return;
    const max = maxScrollTop();
    if (max <= 0) return;
    if (stream.scrollTop !== max) stream.scrollTop = max;
    persistSelectedScroll(max, true);
  };

  const restoreSelectedScroll = (): void => {
    const max = maxScrollTop();
    if (max <= 0) {
      if (stream.scrollTop !== 0) stream.scrollTop = 0;
      return;
    }
    const target = selectedScrollTarget();
    const desiredScrollTop = pinToBottom ? max : Math.max(0, Math.min(target?.outputScrollTop ?? 0, max));
    if (stream.scrollTop !== desiredScrollTop) stream.scrollTop = desiredScrollTop;
    persistSelectedScroll(desiredScrollTop, pinToBottom || desiredScrollTop >= max - BOTTOM_SLACK);
  };

  const onVerticalScrollChange = (): void => {
    syncPinFromScrollPosition();
  };

  const onLayoutReflow = (): void => {
    if (pinToBottom) scrollToBottomIfPinned();
    else restoreSelectedScroll();
  };

  stream.verticalScrollBar.on("change", onVerticalScrollChange);
  stream.content.on(LayoutEvents.LAYOUT_CHANGED, onLayoutReflow);

  const applyScrollIntent = (): void => {
    const intent = state.scrollIntent;
    if (intent === null) return;
    if (intent.stepIndex !== selectedStepIndex) return;
    const max = maxScrollTop();
    const viewportRows = Math.max(1, stream.viewport.height);
    const pageStep = Math.max(1, viewportRows - 1);
    let next = stream.scrollTop;
    if (intent.direction === "home") next = 0;
    else if (intent.direction === "end") next = max;
    else if (intent.direction === "pageup") next -= pageStep;
    else if (intent.direction === "pagedown") next += pageStep;
    else if (intent.direction === "up") next -= 1;
    else if (intent.direction === "down") next += 1;
    next = Math.max(0, Math.min(next, max));
    pinToBottom = max <= 0 || next >= max - BOTTOM_SLACK;
    if (stream.scrollTop !== next) stream.scrollTop = next;
    persistSelectedScroll(next, pinToBottom);
    consumeScrollIntent(state, intent.seq);
  };

  const rebuild = () => {
    const nextSelectedOutput = resolveSelectedOutput(state);
    const nextBackgroundSessionID = nextSelectedOutput.backgroundAgent?.sessionID ?? null;
    const stepChanged =
      nextSelectedOutput.stepIndex !== selectedStepIndex ||
      nextBackgroundSessionID !== selectedBackgroundSessionID;
    selectedOutput = nextSelectedOutput;
    selectedStepIndex = nextSelectedOutput.stepIndex;
    selectedBackgroundSessionID = nextBackgroundSessionID;
    pinToBottom = (selectedOutput.backgroundAgent ?? selectedOutput.step)?.outputPinnedToBottom ?? pinToBottom;
    stream.title = outputTitle(state, selectedOutput);
    const nextOutputKey = outputKey(selectedOutput);
    if (nextOutputKey !== renderedOutputKey) {
      renderedOutputKey = nextOutputKey;
      replaceOutput(selectedOutput.lines, selectedOutput.times);
    }
    renderer.requestRender();
    if (syncingStateScroll) return;
    const hasIntent = state.scrollIntent !== null && state.scrollIntent.stepIndex === selectedStepIndex;
    queueMicrotask(() => {
      if (hasIntent) applyScrollIntent();
      else if (stepChanged || !pinToBottom) restoreSelectedScroll();
      else scrollToBottomIfPinned();
    });
    process.nextTick(() => {
      if (state.scrollIntent !== null && state.scrollIntent.stepIndex === selectedStepIndex) applyScrollIntent();
      else if (stepChanged || !pinToBottom) restoreSelectedScroll();
      else scrollToBottomIfPinned();
    });
  };

  const unsubscribe = subscribe(rebuild);
  rebuild();

  stream.on(RenderableEvents.DESTROYED, () => {
    stream.verticalScrollBar.off("change", onVerticalScrollChange);
    stream.content.off(LayoutEvents.LAYOUT_CHANGED, onLayoutReflow);
    unsubscribe();
  });

  return stream;
}
