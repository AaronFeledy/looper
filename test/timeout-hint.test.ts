import { describe, expect, test } from "bun:test";

import { createLoopState } from "../src/lib/state.ts";
import { footerColor, footerStatus } from "../src/tui/footer.ts";
import {
  formatTimeoutRemaining,
  timeoutExtendHintText,
  timeoutExtendHintThresholdMs,
} from "../src/tui/timeout-hint.ts";

describe("timeoutExtendHintThresholdMs", () => {
  test("uses 10% for timeouts shorter than 2 minutes", () => {
    expect(timeoutExtendHintThresholdMs(30_000)).toBe(3_000);
  });

  test("uses 2 minutes when 10% would be smaller on a medium timeout", () => {
    expect(timeoutExtendHintThresholdMs(10 * 60_000)).toBe(2 * 60_000);
  });

  test("caps at 5 minutes when 10% would be larger", () => {
    expect(timeoutExtendHintThresholdMs(60 * 60_000)).toBe(5 * 60_000);
  });
});

describe("timeoutExtendHintText", () => {
  test("is absent when there is no live timeout", () => {
    expect(timeoutExtendHintText(undefined)).toBeUndefined();
  });

  test("is absent when remaining is above the threshold", () => {
    expect(timeoutExtendHintText({ remainingMs: 10 * 60_000, originalMs: 60 * 60_000 })).toBeUndefined();
  });

  test("is absent when remaining has already elapsed", () => {
    expect(timeoutExtendHintText({ remainingMs: 0, originalMs: 60 * 60_000 })).toBeUndefined();
  });

  test("shows minutes and the extend key at the 60 minute threshold", () => {
    expect(timeoutExtendHintText({ remainingMs: 5 * 60_000, originalMs: 60 * 60_000 }))
      .toBe("timeout in 5m — [t] extend");
  });

  test("shows seconds once remaining is under a minute", () => {
    expect(timeoutExtendHintText({ remainingMs: 45_000, originalMs: 60 * 60_000 }))
      .toBe("timeout in 45s — [t] extend");
  });
});

describe("formatTimeoutRemaining", () => {
  test("floors to whole seconds under a minute", () => {
    expect(formatTimeoutRemaining(1_999)).toBe("1s");
  });

  test("floors to whole minutes at or above a minute", () => {
    expect(formatTimeoutRemaining(119_000)).toBe("1m");
  });
});

describe("footerStatus timeout hint", () => {
  test("shows the hint only when the live timeout is close", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    state.started = true;
    expect(footerStatus(state)).toBe("");

    state.control.bindTimeoutExtender(
      () => ({ remainingMs: 1 }),
      () => ({ remainingMs: 10 * 60_000, originalMs: 60 * 60_000 }),
    );
    expect(footerStatus(state)).toBe("");

    state.control.bindTimeoutExtender(
      () => ({ remainingMs: 1 }),
      () => ({ remainingMs: 90_000, originalMs: 60 * 60_000 }),
    );
    expect(footerStatus(state)).toBe("timeout in 1m — [t] extend");
    expect(footerColor(state)).toBe("#f9e2af");
  });
});
