import { describe, expect, test } from "bun:test";

import { createPausableTimeout, type TimeoutScheduler } from "../src/opencode/pausable-timeout.ts";

class FakeClock implements TimeoutScheduler {
  now = 0;
  readonly timers = new Map<object, { readonly callback: () => void; readonly dueAt: number }>();

  setTimeout(callback: () => void, milliseconds: number): object {
    const handle = {};
    this.timers.set(handle, { callback, dueAt: this.now + milliseconds });
    return handle;
  }

  clearTimeout(handle: object): void {
    this.timers.delete(handle);
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    const due = [...this.timers.entries()].filter(([, timer]) => timer.dueAt <= this.now);
    for (const [handle, timer] of due) {
      this.timers.delete(handle);
      timer.callback();
    }
  }
}

describe("createPausableTimeout", () => {
  test("suspends one timeout interval while overlapping human gates are open", () => {
    // Given
    const clock = new FakeClock();
    let fired = 0;
    const timeout = createPausableTimeout({ durationMs: 100, scheduler: clock, onElapsed: () => { fired += 1; } });

    // When
    clock.advance(40);
    timeout.setGateOpen(true);
    timeout.setGateOpen(true);
    clock.advance(1_000);
    timeout.setGateOpen(false);
    clock.advance(59);

    // Then
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
  });
});
