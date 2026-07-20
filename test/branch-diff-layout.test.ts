import { expect, test } from "bun:test";

import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createLoopState } from "../src/lib/state.ts";
import { createBranchDiffPanel } from "../src/tui/branch-diff.ts";
import { createStepList, LIST_WIDTH } from "../src/tui/step-list.ts";

test("the diff panel renders directly below steps without a blank row", async () => {
  const testRenderer = await createTestRenderer({ width: 40, height: 12 });
  const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
  state.branchDiff = { kind: "ok", additions: 1, deletions: 0, files: 1 };
  const column = new BoxRenderable(testRenderer.renderer, {
    width: LIST_WIDTH,
    height: "100%",
    flexDirection: "column",
  });
  column.add(createStepList(testRenderer.renderer, state));
  column.add(createBranchDiffPanel(testRenderer.renderer, state));
  testRenderer.renderer.root.add(column);

  await testRenderer.renderOnce();

  const frame = testRenderer.captureCharFrame();
  testRenderer.renderer.destroy();
  const lines = frame.split("\n");
  const diffTop = lines.findIndex((line) => line.includes("Diff"));
  expect(diffTop).toBeGreaterThan(0);
  expect(lines.at(diffTop - 1)).toContain("╰");
});
