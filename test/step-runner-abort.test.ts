import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

import { loopStateRunStepContext } from "../src/lib/loop-state-reporter.ts";
import { runOpenCodeStep, type Step } from "../src/lib/runner.ts";
import { createLoopState } from "../src/lib/state.ts";

const SID = "ses_abort";

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function hangingSubscribe() {
  return {
    subscribe: async (_params: unknown, options: { signal: AbortSignal }) => {
      const stream = (async function* (): AsyncGenerator<Event> {
        await rejectOnAbort(options.signal).catch(() => undefined);
      })();
      return { stream };
    },
  };
}

describe("runOpenCodeStep native abort", () => {
  let repoDir: string | undefined;

  afterEach(() => {
    if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true });
  });

  test("returns skipped instead of throwing when prompt rejects with a native AbortError", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-abort-prompt-"));
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step: Step = { name: "build", prompt: "/tmp/unused-prompt" };

    const client = {
      session: {
        create: async () => ({ data: { id: SID } }),
        prompt: async (_params: unknown, options: { signal: AbortSignal }) => {
          queueMicrotask(() => {
            state.skipRequested = true;
          });
          await rejectOnAbort(options.signal);
        },
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
        abort: async () => ({ data: {} }),
      },
      event: hangingSubscribe(),
    } as unknown as OpencodeClient;

    const result = await runOpenCodeStep({
      ctx: loopStateRunStepContext(state, state.control),
      stepIndex: 0,
      prompt: "do the thing",
      client,
      repoDir,
      step,
    });

    expect(result.status).toBe("skipped");
  });

  test("does not send a prompt when skip aborts variant resolution", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-abort-variant-"));
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step: Step = { name: "build", prompt: "/tmp/unused-prompt", variant: "high", model: "openai/gpt-5.5" };
    const prompted: string[] = [];

    const client = {
      session: {
        create: async () => ({ data: { id: SID } }),
        prompt: async (params: { sessionID: string }) => {
          prompted.push(params.sessionID);
          return { data: {} };
        },
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
        abort: async () => ({ data: {} }),
      },
      event: hangingSubscribe(),
      provider: {
        list: async (_params: unknown, options: { signal: AbortSignal }) => {
          queueMicrotask(() => {
            state.skipRequested = true;
          });
          await rejectOnAbort(options.signal);
        },
      },
    } as unknown as OpencodeClient;

    const result = await runOpenCodeStep({
      ctx: loopStateRunStepContext(state, state.control),
      stepIndex: 0,
      prompt: "do the thing",
      client,
      repoDir,
      step,
    });

    expect(result.status).toBe("skipped");
    expect(prompted).toEqual([]);
  });

  test("does not leak an unhandled AbortError after a successful prompt", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-abort-success-teardown-"));
    const continuationDir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(continuationDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(continuationDir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );
    const saved = {
      grace: process.env.LOOPER_EMPTY_ASSISTANT_GRACE_MS,
      poll: process.env.LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS,
      cont: process.env.LOOPER_CONTINUATION_EXIT_GRACE_MS,
    };
    process.env.LOOPER_EMPTY_ASSISTANT_GRACE_MS = "0";
    process.env.LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS = "1";
    process.env.LOOPER_CONTINUATION_EXIT_GRACE_MS = "1";

    const leaks: unknown[] = [];
    const onReject = (reason: unknown) => {
      leaks.push(reason);
    };
    process.on("unhandledRejection", onReject);
    let subscribeAborted = false;
    let promptMessageID = "";

    const client = {
      session: {
        create: async () => ({ data: { id: SID } }),
        prompt: async (params: { messageID: string }) => {
          promptMessageID = params.messageID;
          return { data: {} };
        },
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        messages: async () => ({
          data: [{
            info: { id: "msg_done", role: "assistant", parentID: promptMessageID, time: { completed: Date.now() }, tokens: { output: 1 } },
            parts: [{ id: "prt_done", messageID: "msg_done", type: "text", text: "done" }],
          }],
        }),
        children: async () => ({ data: [] }),
        abort: async () => ({ data: {} }),
      },
      event: {
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => {
          const reader = new ReadableStream({ start() {} }).getReader();
          options.signal.addEventListener("abort", () => {
            subscribeAborted = true;
            void reader.cancel();
          });
          const stream = (async function* (): AsyncGenerator<Event> {
            try {
              await reader.read();
            } catch {
              return;
            }
          })();
          return { stream };
        },
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step: Step = { name: "build", prompt: "/tmp/unused-prompt" };

    try {
      const result = await runOpenCodeStep({
        ctx: loopStateRunStepContext(state, state.control),
        stepIndex: 0,
        prompt: "do the thing",
        client,
        repoDir,
        step,
      });
      await Bun.sleep(0);
      expect(result.status).toBe("done");
      expect(subscribeAborted).toBe(true);
      expect(leaks).toEqual([]);
    } finally {
      process.off("unhandledRejection", onReject);
      if (saved.grace === undefined) delete process.env.LOOPER_EMPTY_ASSISTANT_GRACE_MS;
      else process.env.LOOPER_EMPTY_ASSISTANT_GRACE_MS = saved.grace;
      if (saved.poll === undefined) delete process.env.LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS;
      else process.env.LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS = saved.poll;
      if (saved.cont === undefined) delete process.env.LOOPER_CONTINUATION_EXIT_GRACE_MS;
      else process.env.LOOPER_CONTINUATION_EXIT_GRACE_MS = saved.cont;
    }
  });
});
