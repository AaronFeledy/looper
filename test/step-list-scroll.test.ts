import { expect, test } from "bun:test";

import { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createLoopState, selectStepListRow, subscribe } from "../src/lib/state.ts";
import { createStepList, LIST_WIDTH } from "../src/tui/step-list.ts";

function stepListScrollBox(host: BoxRenderable): ScrollBoxRenderable {
  const child = host.getChildren().find((candidate) => candidate instanceof ScrollBoxRenderable);
  if (!(child instanceof ScrollBoxRenderable)) {
    throw new Error("expected createStepList host to contain a ScrollBoxRenderable");
  }
  return child;
}

function nextStateNotification(): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = subscribe(() => {
      unsubscribe();
      resolve();
    });
  });
}

test("steps panel scrolls when rows overflow the viewport", async () => {
  const stepNames = Array.from({ length: 40 }, (_, index) => `step-${index}`);
  const state = createLoopState({ maxIterations: 1, stepNames });
  selectStepListRow(state, 0);

  const testRenderer = await createTestRenderer({ width: LIST_WIDTH + 4, height: 12 });
  const column = new BoxRenderable(testRenderer.renderer, {
    width: LIST_WIDTH,
    height: "100%",
    flexDirection: "column",
  });
  const host = createStepList(testRenderer.renderer, state);
  const list = stepListScrollBox(host);
  column.add(host);
  testRenderer.renderer.root.add(column);

  await testRenderer.renderOnce();
  await Promise.resolve();
  await testRenderer.renderOnce();

  const max = Math.max(0, list.scrollHeight - list.viewport.height);
  expect(list.viewport.height).toBeGreaterThan(0);
  expect(max).toBeGreaterThan(0);
  expect(list.scrollTop).toBe(0);

  const frameTop = testRenderer.captureCharFrame();
  expect(frameTop).toContain("step-0");
  expect(frameTop).not.toContain("step-39");

  const notified = nextStateNotification();
  selectStepListRow(state, 39);
  await notified;
  await testRenderer.renderOnce();
  await Promise.resolve();
  await testRenderer.renderOnce();

  const frameBottom = testRenderer.captureCharFrame();
  testRenderer.renderer.destroy();

  expect(list.scrollTop).toBeGreaterThan(0);
  expect(list.scrollTop).toBe(Math.max(0, list.scrollHeight - list.viewport.height));
  expect(frameBottom).toContain("step-39");
  expect(frameBottom).not.toContain("step-0");
});
