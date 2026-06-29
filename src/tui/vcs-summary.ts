import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";

import type { LoopState, VcsChange } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";
import { LIST_WIDTH } from "./step-list.ts";
import { displayWidth, truncateDisplay } from "./text-layout.ts";

const PANEL_BORDER = 2;
const PANEL_PADDING_X = 1;
export const VCS_PANEL_TEXT_WIDTH = LIST_WIDTH - PANEL_BORDER - PANEL_PADDING_X * 2;

const COLOR_MUTED = "#6c7086";
const COLOR_ADDED = "#a6e3a1";
const COLOR_MODIFIED = "#f9e2af";
const COLOR_DELETED = "#f38ba8";
const COLOR_RENAMED = "#89b4fa";

export type VcsLine = { content: string; fg: string };

function statusGlyph(status: string): string {
  if (status === "added") return "A";
  if (status === "modified") return "M";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  if (status === "copied") return "C";
  const first = status.charAt(0);
  return first.length > 0 ? first.toUpperCase() : "?";
}

function statusColor(status: string): string {
  if (status === "added" || status === "copied") return COLOR_ADDED;
  if (status === "modified") return COLOR_MODIFIED;
  if (status === "deleted") return COLOR_DELETED;
  if (status === "renamed") return COLOR_RENAMED;
  return COLOR_MUTED;
}

/**
 * Resolve the VCS summary for the step the output pane is showing. Mirrors
 * {@link resolveSelectedOutput}'s candidate order (selected -> active -> first)
 * so this panel tracks the same step. Returns `null` when that step has no
 * changes, so the panel collapses out of layout.
 */
export function selectedVcsSummary(state: LoopState): VcsChange[] | null {
  const candidates = [state.selectedStepIndex, state.activeStepIndex, state.steps.length > 0 ? 0 : null];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const step = state.steps[candidate];
    if (!step) continue;
    const summary = step.vcsSummary;
    return summary !== undefined && summary.length > 0 ? summary : null;
  }
  return null;
}

/**
 * Build one display line per change: `<status> <file>  +<add> -<del>`. The file
 * path is truncated in the middle so the +/- counts always stay visible at the
 * right of a narrow column.
 */
export function buildVcsSummaryLines(changes: VcsChange[], maxWidth: number = VCS_PANEL_TEXT_WIDTH): VcsLine[] {
  return changes.map((change) => {
    const prefix = `${statusGlyph(change.status)} `;
    const suffix = `  +${change.additions} -${change.deletions}`;
    const fileMax = Math.max(0, maxWidth - displayWidth(prefix) - displayWidth(suffix));
    const file = truncateDisplay(change.file, fileMax);
    return { content: `${prefix}${file}${suffix}`, fg: statusColor(change.status) };
  });
}

export function createVcsSummaryPanel(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const panel = new BoxRenderable(renderer, {
    id: "loop-vcs-summary",
    width: LIST_WIDTH,
    flexShrink: 0,
    marginTop: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#45475a",
    title: "Changes",
    titleAlignment: "left",
    paddingX: PANEL_PADDING_X,
    flexDirection: "column",
    visible: false,
  });

  let nextRowId = 0;
  const rows: TextRenderable[] = [];

  const ensureRowCount = (count: number) => {
    while (rows.length > count) {
      const row = rows.pop()!;
      panel.remove(row.id);
      row.destroy();
    }
    while (rows.length < count) {
      const row = new TextRenderable(renderer, {
        id: `loop-vcs-row-${nextRowId++}`,
        width: "100%",
        height: 1,
        content: "",
        fg: COLOR_MUTED,
        truncate: true,
      });
      rows.push(row);
      panel.add(row);
    }
  };

  const update = () => {
    const changes = selectedVcsSummary(state);
    if (changes === null) {
      if (panel.visible) panel.visible = false;
      ensureRowCount(0);
      renderer.requestRender();
      return;
    }
    if (!panel.visible) panel.visible = true;
    const lines = buildVcsSummaryLines(changes);
    ensureRowCount(lines.length);
    lines.forEach((line, index) => {
      const row = rows[index];
      if (!row) return;
      row.content = line.content;
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
