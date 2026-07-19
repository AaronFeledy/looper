import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { afterEach, describe, expect, test } from "bun:test";

import { createLoopState } from "../src/lib/state.ts";
import { createConfigOverlay } from "../src/tui/config-overlay.ts";
import { createTextDialog } from "../src/tui/dialog.ts";
import { createHelpOverlay } from "../src/tui/help-overlay.ts";

const VIEWPORT_WIDTH = 40;
const VIEWPORT_HEIGHT = 24;

function expectDialogWithinViewport(frame: string, readableContent: string): void {
  const lines = frame.split("\n");
  const top = lines.find((line) => line.includes("╭"));
  const bottom = lines.find((line) => line.includes("╰"));

  expect(top).toBeDefined();
  expect(top).toContain("╮");
  expect(bottom).toBeDefined();
  expect(bottom).toContain("╯");
  expect(top?.indexOf("╭")).toBeGreaterThan(0);
  expect(top?.indexOf("╮")).toBeLessThan(VIEWPORT_WIDTH - 1);
  expect(lines.every((line) => [...line].length <= VIEWPORT_WIDTH)).toBe(true);
  expect(frame).toContain(readableContent);
}

describe("responsive text dialogs", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  test("shared dialog stays readable within a 40-column viewport", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
    });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });

    const dialog = createTextDialog(renderer, state, {
      id: "test-dialog",
      borderColor: "#89b4fa",
      width: "80%",
      maxWidth: 88,
      maxHeight: 12,
      isVisible: () => true,
      content: () => ({ title: "shared dialog", body: "readable shared content" }),
    });
    renderer.root.add(dialog);
    await renderOnce();

    expectDialogWithinViewport(captureCharFrame(), "readable shared content");
    renderer.destroy();
  });

  test("help dialog stays readable within a 40-column viewport", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
    });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    state.helpVisible = true;

    renderer.root.add(createHelpOverlay(renderer, state));
    await renderOnce();

    expectDialogWithinViewport(captureCharFrame(), "g/enter");
    renderer.destroy();
  });

  test("config dialog stays readable within a 40-column viewport", async () => {
    scratch = mkdtempSync(join(tmpdir(), "looper-dialog-"));
    writeFileSync(join(scratch, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n");
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
    });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    state.configModalVisible = true;

    const overlay = createConfigOverlay(renderer, state, scratch);
    renderer.root.add(overlay);
    await renderOnce();

    const frame = captureCharFrame();
    const dialog = overlay.findDescendantById("loop-config-dialog");
    expect(dialog).toBeInstanceOf(BoxRenderable);
    if (!(dialog instanceof BoxRenderable)) {
      renderer.destroy();
      return;
    }
    expect(dialog.title).toBe("looper.yaml");
    expect(frame).toContain("looper.yaml");
    expectDialogWithinViewport(frame, "steps:");
    renderer.destroy();
  });

  test("config dialog strips terminal controls while preserving multiline and tab content", async () => {
    scratch = mkdtempSync(join(tmpdir(), "looper-dialog-"));
    writeFileSync(
      join(scratch, "looper.yaml"),
      "first\u001b[2J line\rrewritten\n\tsecond\u001b]52;c;secret\u0007\u009b31m safe\u001b\u007f",
    );
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 20 });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    state.configModalVisible = true;

    const overlay = createConfigOverlay(renderer, state, scratch);
    renderer.root.add(overlay);
    await renderOnce();
    const text = overlay.findDescendantById("loop-config-text");
    expect(text).toBeInstanceOf(TextRenderable);
    if (!(text instanceof TextRenderable)) {
      renderer.destroy();
      return;
    }

    expect(text.chunks.map((chunk) => chunk.text).join("")).toBe("first linerewritten\n\tsecond safe");
    const frame = captureCharFrame();
    renderer.destroy();
    expect(frame).toContain("first linerewritten");
    expect(frame).toContain("second safe");
  });
});
