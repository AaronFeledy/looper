import { describe, expect, test } from "bun:test";

import { bindKeys, type KeyHooks } from "../src/tui/keys.ts";
import { helpLines } from "../src/tui/help-overlay.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";

type KeyEventLike = { name?: string; ctrl?: boolean; sequence?: string; raw?: string; preventDefault?: () => void };

function fakeRenderer(): { renderer: never; press: (k: KeyEventLike) => void } {
  const handlers: ((k: KeyEventLike) => void)[] = [];
  const renderer = {
    keyInput: {
      on: (_event: string, handler: (k: KeyEventLike) => void) => {
        handlers.push(handler);
      },
      off: () => {},
    },
    getSelection: () => null,
  };
  return {
    renderer: renderer as never,
    press: (k: KeyEventLike) => {
      for (const handler of handlers) handler(k);
    },
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

describe("helpLines", () => {
  test("documents the undiscoverable bindings", () => {
    const text = helpLines().join("\n");
    for (const needle of ["ctrl-c", "enter", "?", "tab", "esc", "history"]) {
      expect(text.toLowerCase()).toContain(needle);
    }
  });
});
