import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, test } from "bun:test";

import { createLoopState, enterHistoryView, snapshotIterationToHistory } from "../src/lib/state.ts";
import { createPromptOverlay } from "../src/tui/prompt-overlay.ts";

describe("prompt overlay selection", () => {
  test("keeps its title visible at 40 columns", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 24 });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    state.promptModalVisible = true;

    const overlay = createPromptOverlay(renderer, state);
    renderer.root.add(overlay);
    await renderOnce();
    const frame = captureCharFrame();
    const dialog = overlay.findDescendantById("loop-prompt-dialog");
    expect(dialog).toBeInstanceOf(BoxRenderable);
    if (!(dialog instanceof BoxRenderable)) {
      renderer.destroy();
      return;
    }
    expect(dialog.title).toBe("step prompt");
    renderer.destroy();
    expect(frame).toContain("step prompt");
  });

  test("shows the selected historical step prompt while history is active", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 20 });
    const state = createLoopState({ maxIterations: 2, stepNames: ["build"] });
    const step = state.steps[0];
    expect(step).toBeDefined();
    if (step === undefined) {
      renderer.destroy();
      return;
    }
    state.iteration = 1;
    state.selectedStepIndex = 0;
    step.status = "done";
    step.promptText = "historical prompt";
    snapshotIterationToHistory(state);
    step.promptText = "live prompt";
    enterHistoryView(state);
    state.promptModalVisible = true;

    renderer.root.add(createPromptOverlay(renderer, state));
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();

    expect(frame).toContain("historical prompt");
    expect(frame).not.toContain("live prompt");
  });

  test("sanitizes prompt dialog title and body without changing readable layout", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 20 });
    const state = createLoopState({ maxIterations: 1, stepNames: ["build\u001b]0;owned\u0007\u001b[31m"] });
    const step = state.steps[0];
    expect(step).toBeDefined();
    if (step === undefined) {
      renderer.destroy();
      return;
    }
    step.promptText = "first\u001b[2J line\rrewritten\n\tsecond\u001b]52;c;secret\u0007\u009b31m safe\u001b\u0000";
    state.selectedStepIndex = 0;
    state.promptModalVisible = true;

    const overlay = createPromptOverlay(renderer, state);
    renderer.root.add(overlay);
    await renderOnce();
    const dialog = overlay.findDescendantById("loop-prompt-dialog");
    const text = overlay.findDescendantById("loop-prompt-text");
    expect(dialog).toBeInstanceOf(BoxRenderable);
    expect(text).toBeInstanceOf(TextRenderable);
    if (!(dialog instanceof BoxRenderable) || !(text instanceof TextRenderable)) {
      renderer.destroy();
      return;
    }

    expect(dialog.title).toBe("step prompt");
    expect(text.chunks.map((chunk) => chunk.text).join("")).toBe("first linerewritten\n\tsecond safe");
    const frame = captureCharFrame();
    renderer.destroy();
    expect(frame).toContain("first linerewritten");
    expect(frame).toContain("second safe");
  });
});
