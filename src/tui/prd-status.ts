import { BoxRenderable, RenderableEvents, TextRenderable, fg, t, type CliRenderer, type StyledText } from "@opentui/core";

import type { LoopState, PrdStatus } from "../lib/state.ts";
import { prdPassingGain, subscribe } from "../lib/state.ts";
import { formatRow, LIST_WIDTH } from "./step-list.ts";
import { truncateDisplay } from "./text-layout.ts";

const PANEL_BORDER = 2;
const PANEL_PADDING_X = 1;
export const PRD_PANEL_TEXT_WIDTH = LIST_WIDTH - PANEL_BORDER - PANEL_PADDING_X * 2;

const COLOR_NORMAL = "#cdd6f4";
const COLOR_MUTED = "#6c7086";
const COLOR_PASS = "#a6e3a1";
const COLOR_ERROR = "#f38ba8";

export type PrdPanelLine = { content: string; fg: string; styledContent?: StyledText };

function styleTrailingCheck(content: string): StyledText {
  if (!content.endsWith("✓")) return t`${content}`;
  return t`${content.slice(0, -1)}${fg(COLOR_PASS)("✓")}`;
}

export function buildPrdPanelLines(status: PrdStatus, gain: number = 0, maxWidth: number = PRD_PANEL_TEXT_WIDTH): PrdPanelLine[] {
  const visibleGain = Math.max(0, gain);
  switch (status.kind) {
    case "loading":
      return [{ content: truncateDisplay("loading…", maxWidth), fg: COLOR_MUTED }];
    case "error":
      return [{ content: truncateDisplay(`✗ ${status.message}`, maxWidth), fg: COLOR_ERROR }];
    case "ok": {
      const left = `${status.total - status.remaining}/${status.total}`;
      const baseRight = status.remaining === 0 ? "all passing" : `${status.remaining} left`;
      const baseFg = status.remaining === 0 ? COLOR_PASS : COLOR_NORMAL;
      if (visibleGain >= 2) {
        return [{ content: formatRow(left, `${baseRight} ⚠+${visibleGain}`, maxWidth), fg: COLOR_ERROR }];
      }
      if (visibleGain === 1) {
        const content = formatRow(left, `${baseRight} ✓`, maxWidth);
        return [{ content, fg: baseFg, styledContent: styleTrailingCheck(content) }];
      }
      return [{ content: formatRow(left, baseRight, maxWidth), fg: baseFg }];
    }
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function createPrdPanel(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const panel = new BoxRenderable(renderer, {
    id: "loop-prd-status",
    width: LIST_WIDTH,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: "#45475a",
    title: "PRD",
    titleAlignment: "left",
    paddingX: PANEL_PADDING_X,
    flexDirection: "column",
    visible: true,
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
        id: `loop-prd-row-${nextRowId}`,
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
    const lines = buildPrdPanelLines(state.prd, prdPassingGain(state.prd, state.prdIterationBaseline));
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
