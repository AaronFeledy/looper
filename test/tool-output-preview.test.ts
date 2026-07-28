import { describe, expect, test } from "bun:test";

import {
  previewToolOutputLines,
  toolOutputExpandHint,
  TOOL_OUTPUT_PREVIEW_LINES,
} from "../src/presentation/tui/tool-output-preview.ts";

describe("previewToolOutputLines", () => {
  test("returns all lines when under the preview limit", () => {
    const lines = ["a", "b", "c"];
    const preview = previewToolOutputLines(lines, 10);
    expect(preview.truncated).toBe(false);
    expect(preview.hiddenCount).toBe(0);
    expect(preview.lines).toEqual(lines);
  });

  test("keeps only the first N lines and reports the remainder", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const preview = previewToolOutputLines(lines, 10);
    expect(preview.truncated).toBe(true);
    expect(preview.hiddenCount).toBe(30);
    expect(preview.lines).toEqual(lines.slice(0, 10));
    expect(preview.lines).not.toContain("line 39");
  });

  test("default limit matches TOOL_OUTPUT_PREVIEW_LINES", () => {
    const lines = Array.from({ length: TOOL_OUTPUT_PREVIEW_LINES + 5 }, (_, i) => `${i}`);
    const preview = previewToolOutputLines(lines);
    expect(preview.lines.length).toBe(TOOL_OUTPUT_PREVIEW_LINES);
    expect(preview.hiddenCount).toBe(5);
  });

  test("treats maxLines below 1 as 1", () => {
    const preview = previewToolOutputLines(["a", "b"], 0);
    expect(preview.lines).toEqual(["a"]);
    expect(preview.hiddenCount).toBe(1);
    expect(preview.truncated).toBe(true);
  });
});

describe("toolOutputExpandHint", () => {
  test("collapsed hint names the hidden line count", () => {
    expect(toolOutputExpandHint(1, false)).toBe("▸ 1 more line · click to expand");
    expect(toolOutputExpandHint(12, false)).toBe("▸ 12 more lines · click to expand");
  });

  test("expanded hint invites collapse", () => {
    expect(toolOutputExpandHint(12, true)).toBe("▾ collapse · click to hide full output");
  });
});
