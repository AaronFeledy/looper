import {
  BoxRenderable,
  LayoutEvents,
  RenderableEvents,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";

import type { BackgroundAgent, FlatRow, HistoryStepSnapshot, LoopState, LoopStep, StepStatus } from "../lib/state.ts";
import {
  activateStepListRow,
  completeGroupSelectionId,
  flattenRows,
  isCompleteGroupExpanded,
  subscribe,
} from "../lib/state.ts";
import { agentRowLabel, continuationIndicatorText, isIdleBackgroundAgent } from "../presentation/tui/agent-rows.ts";
import { createWheelScrollAcceleration } from "./wheel-scroll.ts";
import { displayWidth, truncateDisplay } from "./text-layout.ts";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const LIST_WIDTH = 28;
const LIST_BORDER = 2;
const LIST_PADDING_X = 1;
const ROW_WIDTH = LIST_WIDTH - LIST_BORDER - LIST_PADDING_X * 2;

export function stepListStatusIcon(status: StepStatus, frame: string): string {
  if (status === "done") return "✓";
  if (status === "failed") return "✗";
  if (status === "skipped") return "↷";
  if (status === "running") return frame;
  if (status === "waiting") return frame;
  return " ";
}

export function isLiveStepStatus(status: StepStatus): boolean {
  return status === "running" || status === "waiting";
}

export function isPauseEngaged(state: Pick<LoopState, "paused" | "steps">): boolean {
  if (!state.paused) return false;
  for (const step of state.steps) {
    if (isLiveStepStatus(step.status)) return false;
  }
  return true;
}

export type PauseRowAppearance = {
  readonly content: string;
  readonly fg: string;
  readonly bold: boolean;
};

export function pauseRowAppearance(state: Pick<LoopState, "paused" | "steps">): PauseRowAppearance {
  const engaged = isPauseEngaged(state);
  return {
    content: formatRow("⏸ Pause", ""),
    fg: engaged ? COLOR_WAITING : COLOR_MUTED,
    bold: engaged,
  };
}

function hasLiveRow(state: LoopState): boolean {
  for (const step of state.steps) {
    if (isLiveStepStatus(step.status)) return true;
    if (step.backgroundAgents.length > 0) return true;
    if (step.continuation !== undefined) return true;
  }
  return false;
}

export function durationSecondsFrom(
  startedAt: number | undefined,
  finishedAt: number | undefined,
  options: { now?: number; live?: boolean } = {},
): string {
  if (startedAt === undefined) return "";
  const now = options.now ?? Date.now();
  const live = options.live ?? true;
  const end = finishedAt ?? (live ? now : startedAt);
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 600) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function stepDuration(step: { status: StepStatus; startedAt?: number; finishedAt?: number }): string {
  return durationSecondsFrom(step.startedAt, step.finishedAt, { live: isLiveStepStatus(step.status) });
}

function stepRowContent(step: LoopStep, frame: string): string {
  const right = step.statusMessage ?? (continuationIndicatorText(step) || stepDuration(step));
  const icon = step.restartReason === "timeout" ? "◷" : step.restartReason === "manual" ? "↻" : stepListStatusIcon(step.status, frame);
  const label = `${icon} ${step.name}`;
  return formatRow(label, right);
}

function backgroundRowContent(agent: BackgroundAgent, frame: string): string {
  const live = !isIdleBackgroundAgent(agent);
  return formatRow(
    agentRowLabel(agent, frame),
    durationSecondsFrom(agent.startedAt, agent.finishedAt, { live }),
  );
}

export function formatRow(label: string, right: string, max: number = ROW_WIDTH): string {
  if (right.length === 0) return truncateDisplay(label, max);
  const rightWidth = displayWidth(right);
  const labelMax = Math.max(0, max - rightWidth - 1);
  const truncatedLabel = truncateDisplay(label, labelMax);
  const padded = `${truncatedLabel}${" ".repeat(Math.max(0, labelMax - displayWidth(truncatedLabel)))}`;
  return truncateDisplay(`${padded} ${right}`, max);
}

const COLOR_STEP_DONE = "#a6e3a1";
const COLOR_MUTED = "#6c7086";
const COLOR_RUNNING = "#8bd5ff";
const COLOR_WAITING = "#f9e2af";
const COLOR_FAILED = "#f38ba8";
const COLOR_SKIPPED = "#f9e2af";
const COLOR_RESTART_MANUAL = "#cba6f7";
const COLOR_RESTART_TIMEOUT = "#f9e2af";
const COLOR_BACKGROUND_BUSY = "#94e2d5";
const COLOR_BACKGROUND_IDLE = "#6c7086";

export function stepListStatusColor(status: StepStatus): string {
  if (status === "running") return COLOR_RUNNING;
  if (status === "waiting") return COLOR_WAITING;
  if (status === "done") return COLOR_STEP_DONE;
  if (status === "failed") return COLOR_FAILED;
  if (status === "skipped") return COLOR_SKIPPED;
  return COLOR_MUTED;
}

export function backgroundAgentRowColor(agent: BackgroundAgent): string {
  return isIdleBackgroundAgent(agent) ? COLOR_BACKGROUND_IDLE : COLOR_BACKGROUND_BUSY;
}

function stepRowColor(step: LoopStep): string {
  if (step.restartReason === "manual") return COLOR_RESTART_MANUAL;
  if (step.restartReason === "timeout") return COLOR_RESTART_TIMEOUT;
  return stepListStatusColor(step.status);
}

function historyStepRowContent(step: HistoryStepSnapshot, frame: string): string {
  const right = stepDuration(step);
  const icon = step.restartReason === "timeout" ? "◷" : step.restartReason === "manual" ? "↻" : stepListStatusIcon(step.status, frame);
  return formatRow(`${icon} ${step.name}`, right);
}

function historyStepRowColor(step: HistoryStepSnapshot): string {
  if (step.restartReason === "manual") return COLOR_RESTART_MANUAL;
  if (step.restartReason === "timeout") return COLOR_RESTART_TIMEOUT;
  return stepListStatusColor(step.status);
}

function rowBackgroundColor(isSelected: boolean, isFocused: boolean): string | undefined {
  if (!isSelected) return undefined;
  return isFocused ? "#313244" : "#262936";
}

function isRowSelected(state: LoopState, row: FlatRow): boolean {
  if (row.kind === "pause") return false;
  const selectedStepIndex = state.manualStepSelection
    ? state.selectedStepIndex
    : state.selectedStepIndex ?? state.activeStepIndex;
  if (selectedStepIndex === null) return false;
  if (row.stepIndex !== selectedStepIndex) return false;
  if (row.kind === "step") return state.selectedBackgroundSessionID === null;
  if (row.kind === "background-complete") {
    return state.selectedBackgroundSessionID === completeGroupSelectionId(row.parentSessionID);
  }
  return state.selectedBackgroundSessionID === row.sessionID;
}

function completeGroupRowContent(count: number, expanded: boolean, depth: number): string {
  const displayDepth = Math.min(Math.max(depth, 1), 3);
  const prefix = "  ".repeat(displayDepth - 1);
  const chevron = expanded ? "▾" : "▸";
  const label = count === 1 ? "1 Complete" : `${count} Complete`;
  return formatRow(`${prefix}↳ ${chevron} ${label}`, "");
}

export function createStepList(renderer: CliRenderer, state: LoopState): BoxRenderable {
  // Host takes remaining sidebar height (flexBasis 0 + minHeight 0). A bare ScrollBox
  // sizes to content and pushes sibling panels off-screen.
  const host = new BoxRenderable(renderer, {
    id: "loop-step-list-host",
    width: LIST_WIDTH,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 0,
    flexDirection: "column",
  });

  const list = new ScrollBoxRenderable(renderer, {
    id: "loop-step-list",
    width: "100%",
    height: "100%",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: "#45475a",
    title: "Steps",
    paddingX: LIST_PADDING_X,
    scrollY: true,
    scrollX: false,
    stickyScroll: false,
    // Match the agent-stream wheel scale so one terminal notch moves one step row.
    scrollAcceleration: createWheelScrollAcceleration(),
    contentOptions: {
      flexDirection: "column",
      alignItems: "stretch",
      width: "100%",
      // Default scrollY content minHeight 100% pads empty space below the last row.
      minHeight: "auto",
    },
  });
  host.add(list);

  let nextRowId = 0;
  const rowRenderables: TextRenderable[] = [];

  const ensureRowCount = (count: number) => {
    while (rowRenderables.length > count) {
      const row = rowRenderables.pop()!;
      list.remove(row.id);
      row.destroy();
    }
    while (rowRenderables.length < count) {
      const row = new TextRenderable(renderer, {
        id: `loop-step-row-${nextRowId++}`,
        width: "100%",
        height: 1,
        content: "",
        fg: "#6c7086",
        bg: "transparent",
        attributes: TextAttributes.NONE,
        truncate: true,
        selectable: false,
        onMouseUp(event) {
          if (event.type !== "up" || event.button !== 0) return;
          const index = rowRenderables.indexOf(row);
          if (index < 0) return;
          activateStepListRow(state, index);
        },
      });
      rowRenderables.push(row);
      list.add(row);
    }
  };

  let selectedRowIndex: number | null = null;

  const scrollSelectedIntoView = () => {
    if (selectedRowIndex === null || selectedRowIndex < 0) return;
    const viewportHeight = list.viewport.height;
    if (viewportHeight <= 0) return;
    const maxScrollTop = Math.max(0, list.scrollHeight - viewportHeight);
    const top = list.scrollTop;
    if (selectedRowIndex < top) {
      list.scrollTop = Math.min(selectedRowIndex, maxScrollTop);
      return;
    }
    if (selectedRowIndex >= top + viewportHeight) {
      list.scrollTop = Math.min(Math.max(0, selectedRowIndex - viewportHeight + 1), maxScrollTop);
    }
  };

  let frameIndex = 0;

  const updateHistoryRows = () => {
    const view = state.historyView;
    if (view === null) return;
    const entry = state.history[view.entryIndex];
    const steps = entry?.steps ?? [];
    ensureRowCount(steps.length);
    const frame = frames[frameIndex % frames.length]!;
    const isFocused = state.focusedPane === "steps";
    list.borderColor = isFocused ? "#cba6f7" : "#45475a";
    list.title = entry ? `History · iter ${entry.iteration}` : "History";

    steps.forEach((step, index) => {
      const renderable = rowRenderables[index];
      if (!renderable) return;
      const isSelected = index === view.stepIndex;
      renderable.content = historyStepRowContent(step, frame);
      renderable.fg = historyStepRowColor(step);
      renderable.bg = rowBackgroundColor(isSelected, isFocused) ?? "transparent";
      renderable.attributes = isSelected ? TextAttributes.BOLD : TextAttributes.NONE;
    });
    selectedRowIndex = view.stepIndex;
    scrollSelectedIntoView();
    renderer.requestRender();
  };

  const updateRows = () => {
    if (state.historyView !== null) {
      updateHistoryRows();
      return;
    }
    const rows = flattenRows(state);
    ensureRowCount(rows.length);
    const frame = frames[frameIndex % frames.length]!;
    const isFocused = state.focusedPane === "steps";
    list.borderColor = isFocused ? "#89b4fa" : "#45475a";
    list.title = "Steps";

    let selectedIndex: number | null = null;
    rows.forEach((row, index) => {
      const renderable = rowRenderables[index];
      if (!renderable) return;
      if (row.kind === "pause") {
        const appearance = pauseRowAppearance(state);
        renderable.content = appearance.content;
        renderable.fg = appearance.fg;
        renderable.bg = "transparent";
        renderable.attributes = appearance.bold ? TextAttributes.BOLD : TextAttributes.NONE;
        return;
      }
      const step = state.steps[row.stepIndex];
      if (!step) return;
      const isSelected = isRowSelected(state, row);
      if (isSelected) selectedIndex = index;

      if (row.kind === "step") {
        renderable.content = stepRowContent(step, frame);
        renderable.fg = stepRowColor(step);
      } else if (row.kind === "background-complete") {
        renderable.content = completeGroupRowContent(
          row.count,
          isCompleteGroupExpanded(state, row.stepIndex, row.parentSessionID),
          row.depth,
        );
        renderable.fg = COLOR_BACKGROUND_IDLE;
      } else {
        const agent = step.backgroundAgents.find((candidate) => candidate.sessionID === row.sessionID);
        if (!agent) return;
        renderable.content = backgroundRowContent(agent, frame);
        renderable.fg = backgroundAgentRowColor(agent);
      }
      renderable.bg = rowBackgroundColor(isSelected, isFocused) ?? "transparent";
      renderable.attributes = isSelected ? TextAttributes.BOLD : TextAttributes.NONE;
    });
    selectedRowIndex = selectedIndex;
    scrollSelectedIntoView();
    renderer.requestRender();
  };

  const unsubscribe = subscribe(updateRows);
  // scrollHeight is measured after layout; re-pin selection once content size is known.
  list.content.on(LayoutEvents.LAYOUT_CHANGED, scrollSelectedIntoView);
  const timer = setInterval(() => {
    frameIndex += 1;
    if (hasLiveRow(state)) updateRows();
  }, 100);

  host.on(RenderableEvents.DESTROYED, () => {
    clearInterval(timer);
    list.content.off(LayoutEvents.LAYOUT_CHANGED, scrollSelectedIntoView);
    unsubscribe();
  });

  updateRows();
  return host;
}
