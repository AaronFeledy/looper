import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { FOLLOW_INDICATOR } from "../src/lib/output-follow.ts";
import {
  beginStepRun,
  cancelPendingNotify,
  createLoopState,
  pushStepOutputLines,
  selectStepListRow,
  setSelectedStepOutputScroll,
  subscribe,
  type LoopState,
} from "../src/lib/state.ts";
import { createAgentStream } from "../src/tui/agent-stream.ts";
import { bindKeys, type KeyHooks } from "../src/tui/keys.ts";

const NOOP_HOOKS: KeyHooks = {
  onEscape: () => {},
  onInterrupt: () => {},
  onQuit: () => {},
  onRecoveryChoice: () => {},
  onRestart: () => {},
  onSkip: () => {},
  onStart: () => {},
  onStopAfterIteration: () => {},
  onTogglePause: () => {},
};

function createScrollableState(): LoopState {
  const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
  const step = state.steps[0];
  if (step === undefined) throw new Error("test state must contain the build step");
  state.selectedStepIndex = 0;
  state.focusedPane = "output";
  step.outputLines = Array.from({ length: 30 }, (_, index) => `output line ${index}`);
  step.outputLineTimes = step.outputLines.map(() => 1);
  return state;
}

function nextStateNotification(): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = subscribe(() => {
      unsubscribe();
      resolve();
    });
  });
}

function followIndicatorOf(stream: { findDescendantById(id: string): unknown }): {
  fg: string;
} | null {
  const indicator = stream.findDescendantById("loop-agent-follow-indicator") as { fg?: unknown } | null | undefined;
  if (!indicator || typeof indicator !== "object") return null;
  return { fg: String(indicator.fg ?? "") };
}

function isInactiveGray(fg: string): boolean {
  const lower = fg.toLowerCase();
  return lower.includes("6c7086") || lower.includes("0.42, 0.44, 0.53");
}

function isActiveColor(fg: string): boolean {
  return !isInactiveGray(fg);
}

function isolateKeyboardIntent(stream: { readonly verticalScrollBar: object }): void {
  Object.defineProperty(stream.verticalScrollBar, "emit", { configurable: true, value: () => false });
}

function arrowColumn(frame: string): number {
  const bottom = frame.split("\n").filter(Boolean).at(-1) ?? "";
  return bottom.indexOf(FOLLOW_INDICATOR);
}

afterEach(() => {
  cancelPendingNotify();
});

describe("agent stream follow rendering", () => {
  test("places the follow arrow one column under the scrollbar", async () => {
    const state = createScrollableState();
    const testRenderer = await createTestRenderer({ width: 40, height: 8 });
    const stream = createAgentStream(testRenderer.renderer, state);
    testRenderer.renderer.root.add(stream);
    await testRenderer.renderOnce();
    const frame = testRenderer.captureCharFrame();
    const col = arrowColumn(frame);
    testRenderer.renderer.destroy();

    // width 40: corner at 39, scrollbar/track column at 38
    expect(col).toBe(38);
  });

  test("grays the follow arrow when keyboard Home unpins output", async () => {
    const state = createScrollableState();
    const step = state.steps[0];
    if (step === undefined) throw new Error("test state must contain the build step");
    const testRenderer = await createTestRenderer({ width: 40, height: 8 });
    const stream = createAgentStream(testRenderer.renderer, state);
    testRenderer.renderer.root.add(stream);
    const unbind = bindKeys(testRenderer.renderer, state, NOOP_HOOKS);
    await testRenderer.renderOnce();
    expect(testRenderer.captureCharFrame()).toContain(FOLLOW_INDICATOR);
    isolateKeyboardIntent(stream);

    const notified = nextStateNotification();
    testRenderer.mockInput.pressKey("HOME");
    state.selectedStepIndex = null;
    await notified;
    const followIndicator = followIndicatorOf(stream);
    const pinnedToBottom = state.steps[0]?.outputPinnedToBottom;
    const frame = testRenderer.captureCharFrame();
    unbind();
    testRenderer.renderer.destroy();

    expect(pinnedToBottom).toBe(false);
    expect(frame).toContain(FOLLOW_INDICATOR);
    expect(followIndicator && isInactiveGray(followIndicator.fg)).toBe(true);
  });

  test("keeps a gray follow arrow when keyboard Up leaves the bottom", async () => {
    const state = createScrollableState();
    const step = state.steps[0];
    if (step === undefined) throw new Error("test state must contain the build step");
    const testRenderer = await createTestRenderer({ width: 40, height: 8 });
    const stream = createAgentStream(testRenderer.renderer, state);
    testRenderer.renderer.root.add(stream);
    const unbind = bindKeys(testRenderer.renderer, state, NOOP_HOOKS);
    await testRenderer.renderOnce();
    isolateKeyboardIntent(stream);

    const notified = nextStateNotification();
    testRenderer.mockInput.pressArrow("up");
    state.selectedStepIndex = null;
    await notified;
    const followIndicator = followIndicatorOf(stream);
    const pinnedToBottom = state.steps[0]?.outputPinnedToBottom;
    const frame = testRenderer.captureCharFrame();
    unbind();
    testRenderer.renderer.destroy();

    expect(pinnedToBottom).toBe(false);
    expect(frame).toContain(FOLLOW_INDICATOR);
    expect(followIndicator && isInactiveGray(followIndicator.fg)).toBe(true);
  });

  test("recolors the follow arrow when keyboard End re-pins output", async () => {
    const state = createScrollableState();
    const step = state.steps[0];
    if (step === undefined) throw new Error("test state must contain the build step");
    step.outputPinnedToBottom = false;
    step.outputScrollTop = 0;
    const testRenderer = await createTestRenderer({ width: 40, height: 8 });
    const stream = createAgentStream(testRenderer.renderer, state);
    testRenderer.renderer.root.add(stream);
    const unbind = bindKeys(testRenderer.renderer, state, NOOP_HOOKS);
    await testRenderer.renderOnce();
    expect(isInactiveGray(followIndicatorOf(stream)?.fg ?? "")).toBe(true);
    isolateKeyboardIntent(stream);

    const notified = nextStateNotification();
    testRenderer.mockInput.pressKey("END");
    state.selectedStepIndex = null;
    await notified;
    const followIndicator = followIndicatorOf(stream);
    const pinnedToBottom = step.outputPinnedToBottom;
    unbind();
    testRenderer.renderer.destroy();

    expect(pinnedToBottom).toBe(true);
    expect(followIndicator && isActiveColor(followIndicator.fg)).toBe(true);
  });

  test("clicking the follow arrow toggles auto-scroll", async () => {
    const state = createScrollableState();
    const step = state.steps[0];
    if (step === undefined) throw new Error("test state must contain the build step");
    const testRenderer = await createTestRenderer({ width: 40, height: 8 });
    const stream = createAgentStream(testRenderer.renderer, state);
    testRenderer.renderer.root.add(stream);
    await testRenderer.renderOnce();
    expect(step.outputPinnedToBottom).toBe(true);

    const indicator = stream.findDescendantById("loop-agent-follow-indicator");
    if (!indicator) throw new Error("follow indicator missing");
    const notifiedOff = nextStateNotification();
    await testRenderer.mockMouse.click(indicator.x, indicator.y);
    await notifiedOff;
    expect(step.outputPinnedToBottom).toBe(false);
    expect(isInactiveGray(followIndicatorOf(stream)?.fg ?? "")).toBe(true);

    const notifiedOn = nextStateNotification();
    await testRenderer.mockMouse.click(indicator.x, indicator.y);
    await notifiedOn;
    expect(step.outputPinnedToBottom).toBe(true);
    testRenderer.renderer.destroy();
  });

  test("switching to the pinned active step lands at the bottom after layout", async () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["other", "active"] });
    beginStepRun(state, 1);
    state.steps[0]!.outputLines = Array.from({ length: 5 }, (_, index) => `other ${index}`);
    state.steps[0]!.outputLineTimes = state.steps[0]!.outputLines.map(() => 1);
    state.steps[1]!.outputLines = Array.from({ length: 40 }, (_, index) => `active line ${index}`);
    state.steps[1]!.outputLineTimes = state.steps[1]!.outputLines.map(() => 1);
    state.steps[1]!.outputPinnedToBottom = true;
    state.selectedStepIndex = 0;
    state.manualStepSelection = true;

    const testRenderer = await createTestRenderer({ width: 50, height: 12 });
    const stream = createAgentStream(testRenderer.renderer, state);
    testRenderer.renderer.root.add(stream);
    await testRenderer.renderOnce();

    const notified = nextStateNotification();
    selectStepListRow(state, 1);
    await notified;
    await testRenderer.renderOnce();
    await Promise.resolve();
    await testRenderer.renderOnce();

    const max = Math.max(0, stream.scrollHeight - stream.viewport.height);
    const frame = testRenderer.captureCharFrame();
    testRenderer.renderer.destroy();

    expect(state.steps[1]!.outputPinnedToBottom).toBe(true);
    expect(max).toBeGreaterThan(0);
    expect(stream.scrollTop).toBe(max);
    expect(frame).toContain("active line 39");
    expect(frame).not.toContain("active line 0");
  });

  test("pinned follow re-scrolls after content grows past the previous bottom", async () => {
    const state = createScrollableState();
    const step = state.steps[0];
    if (step === undefined) throw new Error("test state must contain the build step");
    step.outputLines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    step.outputLineTimes = step.outputLines.map(() => 1);
    step.outputPinnedToBottom = true;

    const testRenderer = await createTestRenderer({ width: 50, height: 12 });
    const stream = createAgentStream(testRenderer.renderer, state);
    testRenderer.renderer.root.add(stream);
    await testRenderer.renderOnce();
    await Promise.resolve();
    await testRenderer.renderOnce();

    const notified = nextStateNotification();
    pushStepOutputLines(
      state,
      0,
      Array.from({ length: 15 }, (_, index) => `NEW tall content line ${index}`),
    );
    await notified;
    await testRenderer.renderOnce();
    await Promise.resolve();
    await testRenderer.renderOnce();

    const max = Math.max(0, stream.scrollHeight - stream.viewport.height);
    const frame = testRenderer.captureCharFrame();
    testRenderer.renderer.destroy();

    expect(step.outputPinnedToBottom).toBe(true);
    expect(max).toBeGreaterThan(0);
    expect(stream.scrollTop).toBe(max);
    expect(frame).toContain("NEW tall content line 14");
    expect(frame).not.toContain("line 0");
  });

  test("re-pins unpinned output when content shrinks below the viewport", async () => {
    const state = createScrollableState();
    const step = state.steps[0];
    if (step === undefined) throw new Error("test state must contain the build step");
    step.outputPinnedToBottom = false;
    step.outputScrollTop = 2;
    const testRenderer = await createTestRenderer({ width: 40, height: 8 });
    const stream = createAgentStream(testRenderer.renderer, state);
    testRenderer.renderer.root.add(stream);
    await testRenderer.renderOnce();

    step.outputLines = ["short output"];
    step.outputLineTimes = [1];
    const notified = nextStateNotification();
    setSelectedStepOutputScroll(state, step.outputScrollTop, false);
    await notified;
    await Promise.resolve();
    await testRenderer.renderOnce();
    await Promise.resolve();
    const actual = {
      persistedScrollTop: step.outputScrollTop,
      pinnedToBottom: step.outputPinnedToBottom,
      frame: testRenderer.captureCharFrame(),
    };
    testRenderer.renderer.destroy();

    expect(actual.persistedScrollTop).toBe(0);
    expect(actual.pinnedToBottom).toBe(true);
    expect(actual.frame).toContain(FOLLOW_INDICATOR);
  });

  test("re-pins unpinned output when viewport growth makes it non-scrollable", async () => {
    const state = createScrollableState();
    const step = state.steps[0];
    if (step === undefined) throw new Error("test state must contain the build step");
    step.outputPinnedToBottom = false;
    step.outputScrollTop = 2;
    const testRenderer = await createTestRenderer({ width: 40, height: 8 });
    const stream = createAgentStream(testRenderer.renderer, state);
    testRenderer.renderer.root.add(stream);
    await testRenderer.renderOnce();

    testRenderer.resize(40, 60);
    await testRenderer.renderOnce();
    await Promise.resolve();
    await testRenderer.renderOnce();
    await Promise.resolve();
    const actual = {
      persistedScrollTop: step.outputScrollTop,
      pinnedToBottom: step.outputPinnedToBottom,
      frame: testRenderer.captureCharFrame(),
    };
    testRenderer.renderer.destroy();

    expect(actual.persistedScrollTop).toBe(0);
    expect(actual.pinnedToBottom).toBe(true);
    expect(actual.frame).toContain(FOLLOW_INDICATOR);
  });
});
