import type { TodoItem } from "../lib/state.ts";
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
