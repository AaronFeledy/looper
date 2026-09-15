import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { closeBeforeExit, flushOutput, installProcessSignals, runStartupProbe, scheduleProcessExit } from "../src/tui/process-lifecycle.ts";

test("hard exit waits for owned-server cleanup", async () => {
  const order: string[] = [];
  let finish: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  const exiting = closeBeforeExit(async () => { await closed; order.push("reaped"); }, () => { order.push("exit"); });
  expect(order).toEqual([]);
  finish?.();
  await exiting;
  expect(order).toEqual(["reaped", "exit"]);
});

test("flush waits for backpressured writes", async () => {
  let release: (() => void) | undefined;
  const stream = new Writable({ write(_chunk, _encoding, callback) { release = callback; } });
  stream.write("buffered");
  let flushed = false;
  const flushing = flushOutput([stream]).then(() => { flushed = true; });
  await Promise.resolve();
  expect(flushed).toBe(false);
  release?.();
  release?.();
  await flushing;
  expect(flushed).toBe(true);
  stream.destroy();
});

test("flush has a bounded fallback for blocked consumers", async () => {
  const stream = new Writable({ write() {} });
  await flushOutput([stream], 1);
  stream.destroy();
});

test("startup probe is killed and reaped on deadline", async () => {
  const result = await runStartupProbe(["sh", "-c", "exec sleep 60"], { cwd: process.cwd(), timeoutMs: 10 });
  expect(result).toBeUndefined();
});

test("startup probe accepts cancellation before spawning", async () => {
  const signal = AbortSignal.abort();
  const result = await runStartupProbe(["does-not-exist"], { cwd: process.cwd(), signal });
  expect(result).toBeUndefined();
});

test("signal scope handles both frontends and removes listeners on disposal", () => {
  const originalInt = process.listenerCount("SIGINT");
  const originalTerm = process.listenerCount("SIGTERM");
  const received: string[] = [];
  {
    using signals = installProcessSignals((signal) => { received.push(signal); });
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGINT", "SIGINT");
  }
  expect(received).toEqual(["SIGTERM", "SIGINT"]);
  expect(process.listenerCount("SIGINT")).toBe(originalInt);
  expect(process.listenerCount("SIGTERM")).toBe(originalTerm);
});

test("non-TTY exit is deferred so piped output flushes, but is force-exited if the loop stays alive", () => {
  // Given a non-TTY run (piped stdout, which process.exit() would truncate).
  const exited: number[] = [];
  let scheduled: (() => void) | undefined;
  let unrefCalls = 0;

  // When the run finishes.
  scheduleProcessExit({
    tui: false,
    code: 143,
    exit: (code) => exited.push(code),
    schedule: (callback) => {
      scheduled = callback;
      return { unref: () => { unrefCalls += 1; } };
    },
  });

  // Then it does NOT exit immediately (that would cut off buffered pipe writes),
  // and the watchdog is unref'd so a clean unwind is never delayed by it.
  expect(exited).toEqual([]);
  expect(unrefCalls).toBe(1);

  // And if something stays ref'd (an interrupted prompt's SDK socket), the
  // watchdog force-exits instead of hanging forever.
  scheduled?.();
  expect(exited).toEqual([143]);
});

test("TUI exit is immediate because a TTY cannot truncate and its handles never release", () => {
  const exited: number[] = [];
  let scheduled = false;

  scheduleProcessExit({
    tui: true,
    code: 0,
    exit: (code) => exited.push(code),
    schedule: () => { scheduled = true; return {}; },
  });

  expect(exited).toEqual([0]);
  expect(scheduled).toBe(false);
});
