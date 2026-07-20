import { BoxRenderable, RenderableEvents, TextRenderable, fg, t, type CliRenderer, type StyledText } from "@opentui/core";

import type { BranchDiffStatus, LoopState } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";
import { formatRow, LIST_WIDTH } from "./step-list.ts";
import { displayWidth, truncateDisplay } from "./text-layout.ts";

const PANEL_BORDER = 2;
const PANEL_PADDING_X = 1;
export const BRANCH_DIFF_PANEL_TEXT_WIDTH = LIST_WIDTH - PANEL_BORDER - PANEL_PADDING_X * 2;

const COLOR_NORMAL = "#cdd6f4";
const COLOR_MUTED = "#6c7086";
const COLOR_ADDED = "#a6e3a1";
const COLOR_DELETED = "#f38ba8";
const COLOR_ERROR = "#f38ba8";

export type BranchDiffLine = { content: string; fg: string; styledContent?: StyledText };

export function branchDiffPanelVisible(status: BranchDiffStatus): boolean {
  return status.kind !== "hidden";
}

export function buildBranchDiffLines(status: BranchDiffStatus, maxWidth: number = BRANCH_DIFF_PANEL_TEXT_WIDTH): BranchDiffLine[] {
  switch (status.kind) {
    case "hidden":
      return [];
    case "loading":
      return [{ content: truncateDisplay("loading…", maxWidth), fg: COLOR_MUTED }];
    case "error":
      return [{ content: truncateDisplay(`✗ ${status.message}`, maxWidth), fg: COLOR_ERROR }];
    case "ok": {
      const added = `+${status.additions}`;
      const deleted = `-${status.deletions}`;
      const left = `${added} ${deleted}`;
      const right = `${status.files} file${status.files === 1 ? "" : "s"}`;
      const content = formatRow(left, right, maxWidth);
      const fits = displayWidth(left) + displayWidth(right) + 1 <= maxWidth;
      if (!fits) return [{ content, fg: COLOR_NORMAL }];
      const gap = " ".repeat(Math.max(1, maxWidth - displayWidth(left) - displayWidth(right)));
      const styledContent = t`${fg(COLOR_ADDED)(added)} ${fg(COLOR_DELETED)(deleted)}${gap}${fg(COLOR_MUTED)(right)}`;
      return [{ content, fg: COLOR_NORMAL, styledContent }];
    }
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function createBranchDiffPanel(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const panel = new BoxRenderable(renderer, {
    id: "loop-branch-diff",
    width: LIST_WIDTH,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: "#45475a",
    title: "Diff",
    titleAlignment: "left",
    paddingX: PANEL_PADDING_X,
    flexDirection: "column",
    visible: false,
  });

  let nextRowId = 0;
  const rows: TextRenderable[] = [];

  const ensureRowCount = (count: number) => {
    while (rows.length > count) {
      const row = rows.pop();
      if (row === undefined) continue;
      panel.remove(row.id);
      row.destroy();
    }
    while (rows.length < count) {
      const row = new TextRenderable(renderer, {
        id: `loop-branch-diff-row-${nextRowId}`,
        width: "100%",
        height: 1,
        content: "",
        fg: COLOR_MUTED,
        truncate: true,
      });
      nextRowId += 1;
      rows.push(row);
      panel.add(row);
    }
  };

  const update = () => {
    const visible = branchDiffPanelVisible(state.branchDiff);
    if (!visible) {
      if (panel.visible) panel.visible = false;
      ensureRowCount(0);
      renderer.requestRender();
      return;
    }
    if (!panel.visible) panel.visible = true;
    const lines = buildBranchDiffLines(state.branchDiff);
    ensureRowCount(lines.length);
    lines.forEach((line, index) => {
      const row = rows[index];
      if (row === undefined) return;
      row.content = line.styledContent ?? line.content;
      row.fg = line.fg;
    });
    renderer.requestRender();
  };

  update();
  const unsubscribe = subscribe(update);
  panel.on(RenderableEvents.DESTROYED, () => {
    unsubscribe();
  });

  return panel;
}
