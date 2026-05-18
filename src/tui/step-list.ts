import { BoxRenderable, RenderableEvents, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";

import type { LoopState, LoopStep, StepStatus } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function statusIcon(status: StepStatus, frame: string): string {
  if (status === "done") return "✓";
  if (status === "failed") return "✗";
  if (status === "skipped") return "↷";
  if (status === "running") return frame;
  if (status === "waiting") return frame;
  return " ";
}

function hasLiveStep(state: LoopState): boolean {
  return state.steps.some((step) => step.status === "running" || step.status === "waiting");
}

function duration(step: LoopStep): string {
  if (step.startedAt === undefined) return "";
  const finishedAt = step.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((finishedAt - step.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function rowContent(step: LoopStep, frame: string): string {
  const label = `${statusIcon(step.status, frame)} ${step.name}`.padEnd(18, " ");
  return `${label}${step.statusMessage ?? duration(step)}`.slice(0, 28);
}

function rowColor(step: LoopStep): string {
  if (step.status === "running") return "#8bd5ff";
  if (step.status === "waiting") return "#f9e2af";
  if (step.status === "done") return "#a6e3a1";
  if (step.status === "failed") return "#f38ba8";
  if (step.status === "skipped") return "#f9e2af";
  return "#6c7086";
}

function selectedStepIndex(state: LoopState): number | null {
  if (state.manualStepSelection) return state.selectedStepIndex;
  return state.selectedStepIndex ?? state.activeStepIndex;
}

function rowBackgroundColor(isSelected: boolean, isFocused: boolean): string | undefined {
  if (!isSelected) return undefined;
  return isFocused ? "#313244" : "#262936";
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
  const rows: TextRenderable[] = [];

  const ensureRowCount = (count: number) => {
    while (rows.length > count) {
      const row = rows.pop()!;
      list.remove(row.id);
      row.destroy();
    }
    while (rows.length < count) {
      const row = new TextRenderable(renderer, {
        id: `loop-step-row-${nextRowId++}`,
        width: "100%",
        height: 1,
        content: rowContent(
          { name: "", status: "pending", outputLines: [], outputLineTimes: [], outputScrollTop: 0, outputPinnedToBottom: true },
          frames[0]!,
        ),
        fg: rowColor({ name: "", status: "pending", outputLines: [], outputLineTimes: [], outputScrollTop: 0, outputPinnedToBottom: true }),
        bg: "transparent",
        attributes: TextAttributes.NONE,
        truncate: true,
      });
      rows.push(row);
      list.add(row);
    }
  };

  let frameIndex = 0;
  const updateRows = () => {
    ensureRowCount(state.steps.length);
    const frame = frames[frameIndex % frames.length]!;
    const stepIndex = selectedStepIndex(state);
    const isFocused = state.focusedPane === "steps";
    list.borderColor = isFocused ? "#89b4fa" : "#45475a";

    state.steps.forEach((step, index) => {
      const row = rows[index];
      if (!row) return;
      const isSelected = stepIndex === index;
      row.content = rowContent(step, frame);
      row.fg = rowColor(step);
      row.bg = rowBackgroundColor(isSelected, isFocused) ?? "transparent";
      row.attributes = isSelected ? TextAttributes.BOLD : TextAttributes.NONE;
    });
    renderer.requestRender();
  };

  const unsubscribe = subscribe(updateRows);
  const timer = setInterval(() => {
    frameIndex += 1;
    if (hasLiveStep(state)) updateRows();
  }, 100);

  list.on(RenderableEvents.DESTROYED, () => {
    clearInterval(timer);
    unsubscribe();
  });

  updateRows();
  return list;
}
