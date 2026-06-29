import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";

import type { LoopState, TodoItem } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";
import { LIST_WIDTH } from "./step-list.ts";
import { displayWidth, truncateDisplay } from "./text-layout.ts";

const PANEL_BORDER = 2;
const PANEL_PADDING_X = 1;
export const TODO_PANEL_TEXT_WIDTH = LIST_WIDTH - PANEL_BORDER - PANEL_PADDING_X * 2;

const COLOR_MUTED = "#6c7086";
const COLOR_IN_PROGRESS = "#8bd5ff";
const COLOR_PENDING = "#f9e2af";
const COLOR_COMPLETED = "#a6e3a1";
const COLOR_CANCELLED = "#6c7086";

/** Render order: live work first, then queued, then finished, then dropped. */
const STATUS_ORDER = ["in_progress", "pending", "completed", "cancelled"] as const;

export type TodoLine = { content: string; fg: string };

function statusRank(status: string): number {
  const index = STATUS_ORDER.indexOf(status as (typeof STATUS_ORDER)[number]);
  return index === -1 ? STATUS_ORDER.length : index;
}

function statusGlyph(status: string): string {
  if (status === "in_progress") return "[~]";
  if (status === "completed") return "[x]";
  if (status === "cancelled") return "[-]";
  return "[ ]"; // pending / unknown
}

function statusColor(status: string): string {
  if (status === "in_progress") return COLOR_IN_PROGRESS;
  if (status === "completed") return COLOR_COMPLETED;
  if (status === "cancelled") return COLOR_CANCELLED;
  if (status === "pending") return COLOR_PENDING;
  return COLOR_MUTED;
}

function priorityMarker(priority: string): string {
  if (priority === "high") return "!";
  if (priority === "medium") return "*";
  if (priority === "low") return ".";
  return " ";
}

/**
 * Build one display line per todo, grouped/sorted by {@link STATUS_ORDER} (a
 * stable sort preserves the runtime's intra-status ordering). Each line is
 * `<glyph> <priority> <content>` with the content truncated to `maxWidth`.
 * Returns `[]` for an empty list so the panel collapses out of layout.
 */
export function buildTodoPanelLines(todos: TodoItem[], maxWidth: number = TODO_PANEL_TEXT_WIDTH): TodoLine[] {
  if (todos.length === 0) return [];
  const ordered = todos
    .map((todo, index) => ({ todo, index }))
    .sort((a, b) => statusRank(a.todo.status) - statusRank(b.todo.status) || a.index - b.index);

  return ordered.map(({ todo }) => {
    const prefix = `${statusGlyph(todo.status)} ${priorityMarker(todo.priority)} `;
    const contentMax = Math.max(0, maxWidth - displayWidth(prefix));
    const content = truncateDisplay(todo.content, contentMax);
    return { content: `${prefix}${content}`, fg: statusColor(todo.status) };
  });
}

export function createTodoPanel(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const panel = new BoxRenderable(renderer, {
    id: "loop-todo-panel",
    width: LIST_WIDTH,
    flexShrink: 0,
    marginTop: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#45475a",
    title: "TODO",
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
        id: `loop-todo-row-${nextRowId++}`,
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
    const lines = buildTodoPanelLines(state.todos);
    if (lines.length === 0) {
      if (panel.visible) panel.visible = false;
      ensureRowCount(0);
      renderer.requestRender();
      return;
    }
    if (!panel.visible) panel.visible = true;
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
