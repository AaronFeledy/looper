import { mkdtempSync, rmSync } from "node:fs";
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
});
