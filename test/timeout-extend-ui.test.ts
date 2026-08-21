import { describe, expect, test } from "bun:test";

import { createLoopState } from "../src/lib/state.ts";
import { helpLines } from "../src/tui/help-overlay.ts";
import { bindKeys, type KeyHooks } from "../src/tui/keys.ts";

type KeyEventLike = { name?: string; ctrl?: boolean; sequence?: string; raw?: string; preventDefault?: () => void };

function fakeRenderer(): { renderer: never; press: (key: KeyEventLike) => void } {
  const handlers: ((key: KeyEventLike) => void)[] = [];
  const renderer = {
    keyInput: {
      on: (_event: string, handler: (key: KeyEventLike) => void) => {
        handlers.push(handler);
      },
      off: () => {},
    },
    getSelection: () => null,
    copyToClipboardOSC52: () => true,
    clearSelection: () => {},
  };
  return {
    renderer: renderer as never,
    press: (key: KeyEventLike) => {
      for (const handler of handlers) handler(key);
    },
  };
}

function noopHooks(): KeyHooks {
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
  };
}

describe("timeout extend key", () => {
  test("t doubles the bound live step timeout", () => {
    // Given a running step whose timeout extender is bound.
    const state = createLoopState({ maxIterations: 3, stepNames: ["build"] });
    let remainingMs = 10;
    state.control.bindTimeoutExtender(() => {
      remainingMs *= 2;
      return { remainingMs };
    });
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());

    // When the operator presses t.
    fake.press({ name: "t" });

    // Then the live timeout is extended.
    expect(remainingMs).toBe(20);
  });

  test("t is a no-op when no step timeout is live", () => {
    // Given no bound extender.
    const state = createLoopState({ maxIterations: 3, stepNames: ["build"] });
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());

    // When the operator presses t.
    expect(() => fake.press({ name: "t" })).not.toThrow();
  });

  test("help lines mention the timeout-extend key", () => {
    expect(helpLines().some((line) => line.includes("t ") && line.includes("timeout"))).toBe(true);
  });
});
