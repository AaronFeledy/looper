import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, test } from "bun:test";

import { createFooter } from "../src/tui/footer.ts";
import { bindKeys, type KeyHooks } from "../src/tui/keys.ts";
import { createHelpOverlay, helpLines } from "../src/tui/help-overlay.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";

type KeyEventLike = { name?: string; ctrl?: boolean; sequence?: string; raw?: string; preventDefault?: () => void };

function fakeRenderer(selectedText = ""): { renderer: never; press: (k: KeyEventLike) => void; copied: string[]; clearedCount: () => number } {
  const handlers: ((k: KeyEventLike) => void)[] = [];
  const copied: string[] = [];
  let cleared = 0;
  const renderer = {
    keyInput: {
      on: (_event: string, handler: (k: KeyEventLike) => void) => {
        handlers.push(handler);
      },
      off: () => {},
    },
    getSelection: () => (selectedText.length > 0 ? { getSelectedText: () => selectedText } : null),
    copyToClipboardOSC52: (text: string) => {
      copied.push(text);
      return true;
    },
    clearSelection: () => {
      cleared += 1;
    },
  };
  return {
    renderer: renderer as never,
    press: (k: KeyEventLike) => {
      for (const handler of handlers) handler(k);
    },
    copied,
    clearedCount: () => cleared,
  };
}

function noopHooks(overrides: Partial<KeyHooks> = {}): KeyHooks {
  return {
    onEscape: () => {},
    onInterrupt: () => {},
    onQuit: () => {},
    onRecoveryChoice: () => {},
    onRestart: () => {},
    onSkip: () => {},
    onStart: () => {},
    onStopAfterIteration: () => {},
    onTogglePause: () => {},
    ...overrides,
  };
}

function makeState(): LoopState {
  return createLoopState({ maxIterations: 3, stepNames: ["build"] });
}

describe("help overlay keys", () => {
  test("? opens the help overlay", () => {
    const state = makeState();
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());
    fake.press({ sequence: "?" });
    expect(state.helpVisible).toBe(true);
  });

  test("any key closes help without triggering its normal action", () => {
    const state = makeState();
    const fake = fakeRenderer();
    let quitCalls = 0;
    bindKeys(fake.renderer, state, noopHooks({ onQuit: () => { quitCalls += 1; } }));
    fake.press({ sequence: "?" });
    fake.press({ name: "q" });
    expect(state.helpVisible).toBe(false);
    expect(quitCalls).toBe(0);
    fake.press({ name: "q" });
    expect(quitCalls).toBe(1);
  });

  test("esc closes help without arming the stop confirmation", () => {
    const state = makeState();
    const fake = fakeRenderer();
    let escapeCalls = 0;
    bindKeys(fake.renderer, state, noopHooks({ onEscape: () => { escapeCalls += 1; } }));
    fake.press({ sequence: "?" });
    fake.press({ name: "escape" });
    expect(state.helpVisible).toBe(false);
    expect(escapeCalls).toBe(0);
  });
});

describe("prompt overlay keys", () => {
  test("v toggles the step prompt modal", () => {
    const state = makeState();
    const step = state.steps[0];
    if (step) step.promptText = "hello prompt";
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());
    fake.press({ name: "v" });
    expect(state.promptModalVisible).toBe(true);
    fake.press({ name: "q" });
    expect(state.promptModalVisible).toBe(false);
  });

  test("help lines mention the prompt modal key", () => {
    expect(helpLines().some((line) => line.startsWith("v "))).toBe(true);
  });
});

describe("config overlay keys", () => {
  test("c toggles the config modal", () => {
    const state = makeState();
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());
    fake.press({ name: "c" });
    expect(state.configModalVisible).toBe(true);
    fake.press({ name: "q" });
    expect(state.configModalVisible).toBe(false);
  });

  test("any key closes config without triggering its normal action", () => {
    const state = makeState();
    const fake = fakeRenderer();
    let quitCalls = 0;
    bindKeys(fake.renderer, state, noopHooks({ onQuit: () => { quitCalls += 1; } }));
    fake.press({ name: "c" });
    fake.press({ name: "q" });
    expect(state.configModalVisible).toBe(false);
    expect(quitCalls).toBe(0);
    fake.press({ name: "q" });
    expect(quitCalls).toBe(1);
  });

  test("opening config closes help and prompt modals", () => {
    const state = makeState();
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());
    fake.press({ sequence: "?" });
    expect(state.helpVisible).toBe(true);
    fake.press({ name: "c" });
    // first key only closes help
    expect(state.helpVisible).toBe(false);
    expect(state.configModalVisible).toBe(false);
    fake.press({ name: "c" });
    expect(state.configModalVisible).toBe(true);
    fake.press({ name: "v" });
    expect(state.configModalVisible).toBe(false);
    fake.press({ name: "v" });
    expect(state.promptModalVisible).toBe(true);
    fake.press({ name: "c" });
    expect(state.promptModalVisible).toBe(false);
    fake.press({ name: "c" });
    expect(state.configModalVisible).toBe(true);
    expect(state.promptModalVisible).toBe(false);
  });

  test("help lines mention the config modal key", () => {
    expect(helpLines().some((line) => line.startsWith("c "))).toBe(true);
  });
});

describe("modal ctrl+c", () => {
  for (const modal of ["helpVisible", "promptModalVisible", "configModalVisible"] as const) {
    test(`dismisses ${modal} without copying selected text or interrupting`, () => {
      const state = makeState();
      state[modal] = true;
      const fake = fakeRenderer("selected text");
      let interruptCalls = 0;
      let prevented = 0;
      bindKeys(fake.renderer, state, noopHooks({ onInterrupt: () => { interruptCalls += 1; } }));

      fake.press({ ctrl: true, name: "c", preventDefault: () => { prevented += 1; } });

      expect(state[modal]).toBe(false);
      expect(fake.copied).toEqual([]);
      expect(fake.clearedCount()).toBe(0);
      expect(interruptCalls).toBe(0);
      expect(prevented).toBe(1);
    });
  }
});

describe("helpLines", () => {
  test("documents the undiscoverable bindings", () => {
    const text = helpLines().join("\n");
    for (const needle of ["ctrl-c", "enter", "?", "tab", "esc", "history", "config"]) {
      expect(text.toLowerCase()).toContain(needle);
    }
  });

  test("renders every binding and complete borders at 40x24", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 24 });
    const state = makeState();
    state.helpVisible = true;

    renderer.root.add(createHelpOverlay(renderer, state));
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();

    for (const line of helpLines()) expect(frame).toContain(line);
    expect(frame).toContain("keys");
    const frameLines = frame.split("\n");
    const top = frameLines.find((line) => line.includes("╭"));
    const bottom = frameLines.find((line) => line.includes("╰"));
    expect(top).toContain("╮");
    expect(bottom).toContain("╯");
    expect(top?.indexOf("╮")).toBeLessThan(40);
    expect(bottom?.indexOf("╯")).toBeLessThan(40);
  });

  test("renders every binding, complete borders, and the footer in the 40x24 application root", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 24 });
    const state = makeState();
    state.helpVisible = true;
    const root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
    });
    const body = new BoxRenderable(renderer, { width: "100%", flexGrow: 1 });
    body.add(new TextRenderable(renderer, { content: "body" }));
    root.add(body);
    root.add(createHelpOverlay(renderer, state));
    root.add(createFooter(renderer, state));

    renderer.root.add(root);
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();

    for (const line of helpLines()) expect(frame).toContain(line);
    expect(frame).toContain("keys");
    const frameLines = frame.split("\n");
    const top = frameLines.find((line) => line.includes("╭"));
    const bottom = frameLines.find((line) => line.includes("╰"));
    expect(top).toContain("╮");
    expect(bottom).toContain("╯");
    expect(frame).toContain("press any key to close help");
  });
});
