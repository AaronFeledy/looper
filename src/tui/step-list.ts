import { BoxRenderable, RenderableEvents, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";

import type { BackgroundAgent, FlatRow, LoopState, LoopStep, StepStatus } from "../lib/state.ts";
import { backgroundAgentLabel, flattenRows, subscribe } from "../lib/state.ts";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ROW_WIDTH = 26;

function statusIcon(status: StepStatus, frame: string): string {
  if (status === "done") return "✓";
  if (status === "failed") return "✗";
  if (status === "skipped") return "↷";
  if (status === "running") return frame;
  if (status === "waiting") return frame;
  return " ";
}

function hasLiveRow(state: LoopState): boolean {
  for (const step of state.steps) {
    if (step.status === "running" || step.status === "waiting") return true;
    if (step.backgroundAgents.length > 0) return true;
  }
  return false;
}

function durationSecondsFrom(startedAt: number | undefined, finishedAt: number | undefined): string {
  if (startedAt === undefined) return "";
  const end = finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stepRowContent(step: LoopStep, frame: string): string {
  const right = step.statusMessage ?? durationSecondsFrom(step.startedAt, step.finishedAt);
  const label = `${statusIcon(step.status, frame)} ${step.name}`;
  return formatRow(label, right);
}

function backgroundRowContent(agent: BackgroundAgent, frame: string): string {
  const label = `  ↳ ${frame} ${backgroundAgentLabel(agent)}`;
  const right = durationSecondsFrom(agent.startedAt, undefined);
  return formatRow(label, right);
}

function formatRow(label: string, right: string): string {
  const max = ROW_WIDTH;
  if (right.length === 0) return label.slice(0, max);
  const labelMax = Math.max(0, max - right.length - 1);
  const truncatedLabel = label.length > labelMax ? `${label.slice(0, Math.max(0, labelMax - 1))}…` : label;
  const padded = truncatedLabel.padEnd(labelMax, " ");
  return `${padded} ${right}`.slice(0, max);
}

function stepRowColor(step: LoopStep): string {
  if (step.status === "running") return "#8bd5ff";
  if (step.status === "waiting") return "#f9e2af";
  if (step.status === "done") return "#a6e3a1";
  if (step.status === "failed") return "#f38ba8";
  if (step.status === "skipped") return "#f9e2af";
  return "#6c7086";
}

function backgroundRowColor(): string {
  return "#94e2d5";
}

function rowBackgroundColor(isSelected: boolean, isFocused: boolean): string | undefined {
  if (!isSelected) return undefined;
  return isFocused ? "#313244" : "#262936";
}

function isRowSelected(state: LoopState, row: FlatRow): boolean {
  const selectedStepIndex = state.manualStepSelection
    ? state.selectedStepIndex
    : state.selectedStepIndex ?? state.activeStepIndex;
  if (selectedStepIndex === null) return false;
  if (row.stepIndex !== selectedStepIndex) return false;
  if (row.kind === "step") return state.selectedBackgroundSessionID === null;
  return state.selectedBackgroundSessionID === row.sessionID;
}

export function createStepList(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const list = new BoxRenderable(renderer, {
    id: "loop-step-list",
    width: 28,
    height: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: "#45475a",
    title: "Steps",
    paddingX: 1,
    flexDirection: "column",
  });

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
      });
      rowRenderables.push(row);
      list.add(row);
    }
  };

  let frameIndex = 0;
  const updateRows = () => {
    const rows = flattenRows(state);
    ensureRowCount(rows.length);
    const frame = frames[frameIndex % frames.length]!;
    const isFocused = state.focusedPane === "steps";
    list.borderColor = isFocused ? "#89b4fa" : "#45475a";

    rows.forEach((row, index) => {
      const renderable = rowRenderables[index];
      if (!renderable) return;
      const step = state.steps[row.stepIndex];
      if (!step) return;
      const isSelected = isRowSelected(state, row);

      if (row.kind === "step") {
        renderable.content = stepRowContent(step, frame);
        renderable.fg = stepRowColor(step);
      } else {
        const agent = step.backgroundAgents.find((candidate) => candidate.sessionID === row.sessionID);
        if (!agent) return;
        renderable.content = backgroundRowContent(agent, frame);
        renderable.fg = backgroundRowColor();
      }
      renderable.bg = rowBackgroundColor(isSelected, isFocused) ?? "transparent";
      renderable.attributes = isSelected ? TextAttributes.BOLD : TextAttributes.NONE;
    });
    renderer.requestRender();
  };

  const unsubscribe = subscribe(updateRows);
  const timer = setInterval(() => {
    frameIndex += 1;
    if (hasLiveRow(state)) updateRows();
  }, 100);

  list.on(RenderableEvents.DESTROYED, () => {
    clearInterval(timer);
    unsubscribe();
  });

  updateRows();
  return list;
}
