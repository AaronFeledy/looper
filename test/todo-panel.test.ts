import { describe, expect, test } from "bun:test";

import type { TodoItem } from "../src/lib/state.ts";
import { buildTodoPanelLines } from "../src/tui/todo-panel.ts";
import { displayWidth } from "../src/tui/text-layout.ts";

const sample: TodoItem[] = [
  { content: "done thing", status: "completed", priority: "low" },
  { content: "active thing", status: "in_progress", priority: "high" },
  { content: "cancelled thing", status: "cancelled", priority: "medium" },
  { content: "todo thing", status: "pending", priority: "medium" },
];

describe("buildTodoPanelLines", () => {
  test("groups by status: in_progress, pending, completed, cancelled", () => {
    const lines = buildTodoPanelLines(sample, 40);
    expect(lines.map((line) => line.content)).toEqual([
      "[~] ! active thing",
      "[ ] * todo thing",
      "[x] . done thing",
      "[-] * cancelled thing",
    ]);
  });

  test("uses status-driven colors", () => {
    const lines = buildTodoPanelLines(sample, 40);
    expect(lines[0]!.fg).toBe("#8bd5ff"); // in_progress
    expect(lines[1]!.fg).toBe("#f9e2af"); // pending
    expect(lines[2]!.fg).toBe("#a6e3a1"); // completed
    expect(lines[3]!.fg).toBe("#6c7086"); // cancelled
  });

  test("returns empty array when there are no todos (panel hides)", () => {
    expect(buildTodoPanelLines([], 40)).toEqual([]);
  });

  test("truncates long content to the panel width with an ellipsis", () => {
    const lines = buildTodoPanelLines(
      [{ content: "a very long todo item that exceeds the column", status: "pending", priority: "low" }],
      14,
    );
    expect(displayWidth(lines[0]!.content)).toBeLessThanOrEqual(14);
    expect(lines[0]!.content.startsWith("[ ] . ")).toBe(true);
    expect(lines[0]!.content.endsWith("…")).toBe(true);
  });
});
