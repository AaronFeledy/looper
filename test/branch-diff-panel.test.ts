import { describe, expect, test } from "bun:test";

import type { BranchDiffStatus } from "../src/lib/state.ts";
import { branchDiffPanelVisible, buildBranchDiffLines } from "../src/tui/branch-diff.ts";
import { displayWidth } from "../src/tui/text-layout.ts";

describe("branchDiffPanelVisible", () => {
  test("hidden collapses the panel", () => {
    expect(branchDiffPanelVisible({ kind: "hidden" })).toBe(false);
  });

  test("ok, loading and error keep the panel visible", () => {
    expect(branchDiffPanelVisible({ kind: "loading" })).toBe(true);
    expect(branchDiffPanelVisible({ kind: "ok", additions: 0, deletions: 0, files: 0 })).toBe(true);
    expect(branchDiffPanelVisible({ kind: "error", message: "x" })).toBe(true);
  });
});

describe("buildBranchDiffLines", () => {
  test("hidden status yields no rows", () => {
    expect(buildBranchDiffLines({ kind: "hidden" }, 26)).toEqual([]);
  });

  test("formats +additions -deletions and a pluralized file count", () => {
    const line = buildBranchDiffLines({ kind: "ok", additions: 12, deletions: 3, files: 4 }, 26)[0]!;
    expect(line.content).toContain("+12 -3");
    expect(line.content).toContain("4 files");
    expect(displayWidth(line.content)).toBeLessThanOrEqual(26);
  });

  test("uses a singular file label for one file", () => {
    const line = buildBranchDiffLines({ kind: "ok", additions: 1, deletions: 0, files: 1 }, 26)[0]!;
    expect(line.content).toContain("1 file");
    expect(line.content).not.toContain("1 files");
  });

  test("colors the additions and deletions segments", () => {
    const line = buildBranchDiffLines({ kind: "ok", additions: 5, deletions: 2, files: 3 }, 26)[0]!;
    expect(line.styledContent).toBeDefined();
    const texts = line.styledContent!.chunks.map((chunk) => chunk.text);
    expect(texts).toContain("+5");
    expect(texts).toContain("-2");
    const additions = line.styledContent!.chunks.find((chunk) => chunk.text === "+5");
    const deletions = line.styledContent!.chunks.find((chunk) => chunk.text === "-2");
    expect(additions?.fg).toBeDefined();
    expect(deletions?.fg).toBeDefined();
    expect(additions?.fg).not.toEqual(deletions?.fg);
  });

  test("renders a muted loading line", () => {
    const line = buildBranchDiffLines({ kind: "loading" }, 26)[0]!;
    expect(line.content).toContain("loading");
    expect(line.fg).toBe("#6c7086");
  });

  test("keeps error lines red and width-safe", () => {
    const line = buildBranchDiffLines({ kind: "error", message: "not a git repository at all" }, 16)[0]!;
    expect(line.content).toStartWith("✗ ");
    expect(line.content).toEndWith("…");
    expect(line.fg).toBe("#f38ba8");
    expect(displayWidth(line.content)).toBeLessThanOrEqual(16);
  });

  test("stays within max width for large counts", () => {
    const line = buildBranchDiffLines({ kind: "ok", additions: 99999, deletions: 88888, files: 1234 }, 16)[0]!;
    expect(displayWidth(line.content)).toBeLessThanOrEqual(16);
  });
});
