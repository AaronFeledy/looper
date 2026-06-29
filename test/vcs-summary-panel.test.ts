import { describe, expect, test } from "bun:test";

import { createLoopState, type VcsChange } from "../src/lib/state.ts";
import { buildVcsSummaryLines, selectedVcsSummary } from "../src/tui/vcs-summary.ts";
import { displayWidth } from "../src/tui/text-layout.ts";

describe("selectedVcsSummary", () => {
  test("returns null when the selected step has no vcs summary", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Test"] });
    expect(selectedVcsSummary(state)).toBeNull();
  });

  test("returns the selected step's changes", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Test"] });
    state.steps[0]!.vcsSummary = [{ file: "src/a.ts", additions: 3, deletions: 1, status: "modified" }];
    state.selectedStepIndex = 0;
    state.manualStepSelection = true;
    const changes = selectedVcsSummary(state);
    expect(changes).not.toBeNull();
    expect(changes!).toHaveLength(1);
    expect(changes![0]!.file).toBe("src/a.ts");
  });

  test("returns null when the selected step's summary is empty", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    state.steps[0]!.vcsSummary = [];
    state.selectedStepIndex = 0;
    state.manualStepSelection = true;
    expect(selectedVcsSummary(state)).toBeNull();
  });
});

describe("buildVcsSummaryLines", () => {
  const change: VcsChange = { file: "a.ts", additions: 12, deletions: 3, status: "added" };

  test("formats <status> <file>  +<additions> -<deletions>", () => {
    const lines = buildVcsSummaryLines([change], 40);
    expect(lines[0]!.content).toBe("A a.ts  +12 -3");
  });

  test("colors lines by status", () => {
    const lines = buildVcsSummaryLines(
      [
        { file: "a.ts", additions: 1, deletions: 0, status: "added" },
        { file: "b.ts", additions: 1, deletions: 1, status: "modified" },
        { file: "c.ts", additions: 0, deletions: 1, status: "deleted" },
      ],
      40,
    );
    expect(lines[0]!.fg).toBe("#a6e3a1");
    expect(lines[1]!.fg).toBe("#f9e2af");
    expect(lines[2]!.fg).toBe("#f38ba8");
  });

  test("truncates a long file path but keeps the +/- counts", () => {
    const lines = buildVcsSummaryLines(
      [{ file: "src/very/deep/path/to/module.ts", additions: 5, deletions: 2, status: "modified" }],
      20,
    );
    expect(displayWidth(lines[0]!.content)).toBeLessThanOrEqual(20);
    expect(lines[0]!.content.includes("+5 -2")).toBe(true);
  });
});
