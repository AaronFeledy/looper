import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

import { createSessionEventConsumer } from "../src/lib/event-consumer.ts";
import { runOpenCodeStep, type Step } from "../src/lib/runner.ts";
import { createLoopState } from "../src/lib/state.ts";

const SID = "ses_reconnect";
const MID = "msg_a";
const PID = "p_1";

function assistantUpdated(): Event {
  return { type: "message.updated", properties: { info: { id: MID, role: "assistant" } } } as unknown as Event;
}

function assistantDone(parentID: string): { info: unknown; parts: unknown[] } {
  return { info: { id: "msg_done", role: "assistant", parentID, time: { completed: Date.now() } }, parts: [] };
}

function assistantFatalError(): { info: unknown; parts: unknown[] } {
  return {
    info: {
      id: "msg_later_error",
      role: "assistant",
      parentID: "msg_auto_continue",
      error: { name: "APIError", data: { message: "thinking blocks cannot be modified", isRetryable: false } },
    },
    parts: [],
  };
}

function textPartUpdated(text: string): Event {
  return {
    type: "message.part.updated",
    properties: { part: { id: PID, sessionID: SID, messageID: MID, type: "text", text } },
  } as unknown as Event;
}

async function* fromArray(events: Event[]): AsyncGenerator<Event> {
  for (const event of events) yield event;
}

describe("createSessionEventConsumer reconnect", () => {
  test("does not reprint content already shown when a new stream is consumed", async () => {
    const lines: string[] = [];
    const consumer = createSessionEventConsumer(SID, { pushLine: (line) => lines.push(line) });

    await consumer.consume(fromArray([assistantUpdated(), textPartUpdated("hello\n")]));
    await consumer.consume(fromArray([textPartUpdated("hello\nworld\n")]));
    consumer.flush();

    const content = lines.filter((line) => line.includes("hello") || line.includes("world"));
    expect(content.filter((line) => line.includes("hello")).length).toBe(1);
    expect(content.filter((line) => line.includes("world")).length).toBe(1);
  });

  test("backfill recovers content missed during a disconnect without duplicating", async () => {
    const lines: string[] = [];
    const consumer = createSessionEventConsumer(SID, { pushLine: (line) => lines.push(line) });

    await consumer.consume(fromArray([assistantUpdated(), textPartUpdated("hello\n")]));
    consumer.backfill([
      { info: { id: MID, role: "assistant" } as never, parts: [{ id: PID, messageID: MID, type: "text", text: "hello\nworld\n" } as never] },
    ]);
    consumer.flush();

    expect(lines.filter((line) => line.includes("hello")).length).toBe(1);
    expect(lines.filter((line) => line.includes("world")).length).toBe(1);
  });
});

describe("runOpenCodeStep event stream recovery", () => {
  let repoDir: string | undefined;

  afterEach(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
    repoDir = undefined;
  });

  test("resubscribes when the event stream ends early while the session is still busy", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-reconnect-"));
    const continuationDir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(continuationDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(continuationDir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );

    let subscribeCount = 0;
    let resolveSecondSubscribe: () => void = () => {};
    const secondSubscribed = new Promise<void>((resolve) => {
      resolveSecondSubscribe = resolve;
    });

    const client = {
      session: {
        create: async () => ({ data: { id: SID } }),
        prompt: async () => {
          await secondSubscribed;
          return { data: {} };
        },
        status: async () => ({ data: { [SID]: { type: subscribeCount >= 2 ? "idle" : "busy" } } }),
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
        abort: async () => ({ data: {} }),
      },
      event: {
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => {
          subscribeCount += 1;
          if (subscribeCount === 1) {
            return { stream: fromArray([assistantUpdated(), textPartUpdated("hello\n")]) };
          }
          resolveSecondSubscribe();
          const signal = options.signal;
          const stream = (async function* (): AsyncGenerator<Event> {
            await new Promise<void>((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })();
          return { stream };
        },
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step: Step = { name: "build", prompt: "/tmp/unused-prompt" };

    const result = await runOpenCodeStep({
      state,
      stepIndex: 0,
      prompt: "do the thing",
      client,
      repoDir,
      step,
      sessionID: SID,
    });

    expect(result.status).toBe("done");
    expect(subscribeCount).toBeGreaterThanOrEqual(2);
    const output = state.steps[0]?.outputLines ?? [];
    expect(output.some((line) => line.includes("hello"))).toBe(true);
    expect(output.some((line) => line.includes("resubscribed"))).toBe(true);
  });

  test("returns a timeout restart when the prompt exceeds the step timeout", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-timeout-"));
    let abortCalled = false;

    const client = {
      session: {
        create: async () => ({ data: { id: SID } }),
        prompt: async (_params: unknown, options: { signal: AbortSignal }) => {
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) return resolve();
            options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
        status: async () => ({ data: { [SID]: { type: "busy" } } }),
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
        abort: async () => {
          abortCalled = true;
          return { data: {} };
        },
      },
      event: {
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => {
          const signal = options.signal;
          const stream = (async function* (): AsyncGenerator<Event> {
            await new Promise<void>((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })();
          return { stream };
        },
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step: Step = { name: "build", prompt: "/tmp/unused-prompt", timeoutMs: 25 };

    const result = await runOpenCodeStep({
      state,
      stepIndex: 0,
      prompt: "do the thing",
      client,
      repoDir,
      step,
    });

    expect(result.status).toBe("restart");
    expect(result.restartReason).toBe("timeout");
    expect(abortCalled).toBe(true);
  });

  test("fails instead of waiting when a later assistant has a non-retryable error", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-fatal-later-"));
    let promptMessageID = "";

    const client = {
      session: {
        create: async () => ({ data: { id: SID } }),
        prompt: async (params: { messageID: string }, options: { signal: AbortSignal }) => {
          promptMessageID = params.messageID;
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) return resolve();
            options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        messages: async () => ({ data: [assistantDone(promptMessageID), assistantFatalError()] }),
        children: async () => ({ data: [] }),
        abort: async () => ({ data: {} }),
      },
      event: {
        subscribe: async () => ({ stream: fromArray([]) }),
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step: Step = { name: "build", prompt: "/tmp/unused-prompt" };

    const result = await runOpenCodeStep({
      state,
      stepIndex: 0,
      prompt: "do the thing",
      client,
      repoDir,
      step,
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("thinking blocks cannot be modified");
    expect(state.steps[0]?.outputLines.some((line) => line.includes("thinking blocks cannot be modified"))).toBe(true);
  }, 25000);
});
