import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

import { loopStateRunStepContext } from "../src/lib/loop-state-reporter.ts";
import { reattachOpenCodeStep, type Step } from "../src/lib/runner.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths } from "../src/lib/state-files.ts";

const SID = "ses_reattach_abort";
const MID = "msg_reattach_abort";

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function assistantDone(parentID: string): { info: unknown; parts: unknown[] } {
  return {
    info: { id: "msg_done", role: "assistant", parentID, time: { completed: Date.now() }, tokens: { output: 1 } },
    parts: [{ id: "prt_done", messageID: "msg_done", type: "text", text: "done" }],
  };
}

function writeIdleContinuationRecord(repoDir: string, sessionID: string): void {
  const continuationDir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(continuationDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(continuationDir, `${sessionID}.json`),
    JSON.stringify({ sessionID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
  );
}

function collectUnhandledRejections(): { readonly reasons: unknown[]; readonly stop: () => void } {
  const reasons: unknown[] = [];
  const onReject = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", onReject);
  return {
    reasons,
    stop: () => {
      process.off("unhandledRejection", onReject);
    },
  };
}

describe("reattachOpenCodeStep native abort", () => {
  let repoDir: string | undefined;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ["LOOPER_EMPTY_ASSISTANT_GRACE_MS", "LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS", "LOOPER_CONTINUATION_EXIT_GRACE_MS"] as const) {
      savedEnv.set(key, process.env[key]);
    }
    process.env.LOOPER_EMPTY_ASSISTANT_GRACE_MS = "0";
    process.env.LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS = "1";
    process.env.LOOPER_CONTINUATION_EXIT_GRACE_MS = "1";
  });

  afterEach(() => {
    if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true });
    repoDir = undefined;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  test("aborts event.subscribe on idle teardown without an unhandled rejection", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-reattach-abort-teardown-"));
    initStatePaths({ configDir: repoDir });
    writeIdleContinuationRecord(repoDir, SID);
    const leaks = collectUnhandledRejections();
    let subscribeAborted = false;

    const client = {
      session: {
        abort: async () => ({ data: {} }),
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        messages: async () => ({ data: [assistantDone(MID)] }),
        children: async () => ({ data: [] }),
      },
      event: {
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => {
          const reader = new ReadableStream({
            cancel: () => Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
          }).getReader();
          options.signal.addEventListener("abort", () => {
            subscribeAborted = true;
            void reader.cancel();
          });
          const stream = (async function* (): AsyncGenerator<Event> {
            await rejectOnAbort(options.signal);
          })();
          return { stream };
        },
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step: Step = { name: "build", prompt: "/tmp/unused-prompt" };

    const result = await reattachOpenCodeStep({
      ctx: loopStateRunStepContext(state, state.control),
      stepIndex: 0,
      client,
      repoDir,
      step,
      sessionID: SID,
      outcomeMessageID: MID,
    });
    await Bun.sleep(0);
    leaks.stop();

    expect(result.errorMessage).toBeUndefined();
    expect(result.status).toBe("done");
    expect(subscribeAborted).toBe(true);
    expect(leaks.reasons).toEqual([]);
    expect(state.steps[0]?.outputLines.some((line) => line.includes("reattach failed to subscribe"))).toBe(false);
  });
});
