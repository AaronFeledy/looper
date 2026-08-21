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

  test("adds the original duration to remaining and skips the original deadline", () => {
    // Given a 100ms timeout that has already consumed 40ms.
    const clock = new FakeClock();
    let fired = 0;
    const timeout = createPausableTimeout({ durationMs: 100, scheduler: clock, onElapsed: () => { fired += 1; } });
    clock.advance(40);

    // When the operator adds another original timeout.
    expect(timeout.extend()).toBe(160);

    // Then it fires only after the leftover 60ms plus another 100ms.
    clock.advance(159);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
  });

  test("adds the original duration even when almost elapsed", () => {
    // Given a 100ms timeout with only 10ms left.
    const clock = new FakeClock();
    let fired = 0;
    const timeout = createPausableTimeout({ durationMs: 100, scheduler: clock, onElapsed: () => { fired += 1; } });
    clock.advance(90);

    // When the operator extends.
    expect(timeout.extend()).toBe(110);

    // Then they get the leftover 10ms plus one full original duration.
    clock.advance(109);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
  });

  test("each press adds another original duration", () => {
    // Given a fresh 100ms timeout.
    const clock = new FakeClock();
    let fired = 0;
    const timeout = createPausableTimeout({ durationMs: 100, scheduler: clock, onElapsed: () => { fired += 1; } });

    // When the operator extends twice.
    expect(timeout.extend()).toBe(200);
    expect(timeout.extend()).toBe(300);

    // Then the timer lasts three original durations from the start.
    clock.advance(299);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
  });

  test("extends remaining while a human gate is holding the timer", () => {
    // Given a paused timeout with 60ms remaining.
    const clock = new FakeClock();
    let fired = 0;
    const timeout = createPausableTimeout({ durationMs: 100, scheduler: clock, onElapsed: () => { fired += 1; } });
    clock.advance(40);
    timeout.setGateOpen(true);

    // When the operator extends during the gate, then the gate closes.
    expect(timeout.extend()).toBe(160);
    timeout.setGateOpen(false);

    // Then the added original duration starts only after the gate closes.
    clock.advance(159);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
  });

  test("reports remaining time without mutating the deadline", () => {
    // Given a 100ms timeout that has consumed 40ms.
    const clock = new FakeClock();
    let fired = 0;
    const timeout = createPausableTimeout({ durationMs: 100, scheduler: clock, onElapsed: () => { fired += 1; } });
    clock.advance(40);

    // When remaining is read, then time continues.
    expect(timeout.remainingMs()).toBe(60);
    expect(timeout.originalMs()).toBe(100);
    clock.advance(59);
    expect(fired).toBe(0);
    expect(timeout.remainingMs()).toBe(1);
    clock.advance(1);
    expect(fired).toBe(1);
    expect(timeout.remainingMs()).toBe(0);
  });

  test("does nothing after dispose", () => {
    // Given a disposed timeout.
    const clock = new FakeClock();
    let fired = 0;
    const timeout = createPausableTimeout({ durationMs: 100, scheduler: clock, onElapsed: () => { fired += 1; } });
    timeout.dispose();

    // When extend is called after dispose.
    expect(timeout.extend()).toBeUndefined();
    expect(timeout.remainingMs()).toBeUndefined();
    clock.advance(1_000);

    // Then the timer never fires.
    expect(fired).toBe(0);
  });
});
