import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

import { createSessionEventConsumer } from "../src/lib/event-consumer.ts";
import { reattachOpenCodeStep, runOpenCodeStep, type Step } from "../src/lib/runner.ts";
import { createLoopState } from "../src/lib/state.ts";

const SID = "ses_reconnect";
const MID = "msg_a";
const PID = "p_1";

function assistantUpdated(): Event {
  return { type: "message.updated", properties: { info: { id: MID, role: "assistant" } } } as unknown as Event;
}

function assistantDone(parentID: string): { info: unknown; parts: unknown[] } {
  return {
    info: { id: "msg_done", role: "assistant", parentID, time: { completed: Date.now() }, tokens: { output: 1 } },
    parts: [{ id: "prt_done", messageID: "msg_done", type: "text", text: "done" }],
  };
}

function assistantEmpty(parentID: string): { info: unknown; parts: unknown[] } {
  return {
    info: {
      id: "msg_empty",
      role: "assistant",
      parentID,
      time: { completed: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: "prt_start", messageID: "msg_empty", type: "step-start", snapshot: "" }],
  };
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

  test("fails closed when opencode completes with only an empty assistant shell", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-empty-assistant-"));
    const continuationDir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(continuationDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(continuationDir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );
    let promptMessageID = "";

    const client = {
      session: {
        create: async () => ({ data: { id: SID } }),
        prompt: async (params: { messageID: string }) => {
          promptMessageID = params.messageID;
          return { data: {} };
        },
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        messages: async () => ({ data: [assistantEmpty(promptMessageID)] }),
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
    expect(result.errorMessage).toContain("completed without assistant output");
  });

  test("keeps meaningful assistant completions successful", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-meaningful-assistant-"));
    const continuationDir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(continuationDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(continuationDir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );
    let promptMessageID = "";

    const client = {
      session: {
        create: async () => ({ data: { id: SID } }),
        prompt: async (params: { messageID: string }) => {
          promptMessageID = params.messageID;
          return { data: {} };
        },
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        messages: async () => ({ data: [assistantDone(promptMessageID)] }),
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

    expect(result.status).toBe("done");
  });

  test("ignores trailing empty assistant placeholders after meaningful completions", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-meaningful-then-empty-assistant-"));
    const continuationDir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(continuationDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(continuationDir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );
    let promptMessageID = "";

    const client = {
      session: {
        create: async () => ({ data: { id: SID } }),
        prompt: async (params: { messageID: string }) => {
          promptMessageID = params.messageID;
          return { data: {} };
        },
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        messages: async () => ({ data: [assistantDone(promptMessageID), assistantEmpty(promptMessageID)] }),
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

    expect(result.status).toBe("done");
  });

  test("reattach fails closed when the completed assistant message is empty", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-reattach-empty-assistant-"));

    const client = {
      session: {
        abort: async () => ({ data: {} }),
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        messages: async () => ({ data: [assistantEmpty(MID)] }),
        children: async () => ({ data: [] }),
      },
      event: {
        subscribe: async () => ({ stream: fromArray([]) }),
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step: Step = { name: "build", prompt: "/tmp/unused-prompt" };

    const result = await reattachOpenCodeStep({
      state,
      stepIndex: 0,
      client,
      repoDir,
      step,
      sessionID: SID,
      messageID: MID,
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("completed without assistant output");
  });

  test("reattach backfill is bounded when messages hangs during teardown", async () => {
    const originalProbeTimeout = process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS;
    process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS = "1";
    repoDir = mkdtempSync(join(tmpdir(), "looper-reattach-backfill-timeout-"));
    const continuationDir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(continuationDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(continuationDir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );
    let messagesCalls = 0;

    const client = {
      session: {
        abort: async () => ({ data: {} }),
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        messages: async () => {
          messagesCalls += 1;
          if (messagesCalls === 1) return await new Promise<never>(() => {});
          return { data: [assistantDone(MID)] };
        },
        children: async () => ({ data: [] }),
      },
      event: {
        subscribe: async () => ({ stream: fromArray([]) }),
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step: Step = { name: "build", prompt: "/tmp/unused-prompt" };

    try {
      const result = await reattachOpenCodeStep({
        state,
        stepIndex: 0,
        client,
        repoDir,
        step,
        sessionID: SID,
        messageID: MID,
      });

      expect(result.status).toBe("done");
      expect(state.steps[0]!.outputLines.some((line) => line.includes("reattach backfill timed out"))).toBe(true);
    } finally {
      if (originalProbeTimeout === undefined) delete process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS;
      else process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS = originalProbeTimeout;
    }
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
