import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { runIteration } from "../src/lib/orchestrator.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";

function writeIdleContinuationRecord(repoDir: string, sessionID: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${sessionID}.json`),
    JSON.stringify({ sessionID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
  );
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function makeRestartClient({
  repoDir,
  state,
  mode,
}: {
  repoDir: string;
  state: LoopState;
  mode: "manual" | "timeout";
}): { client: OpencodeClient; createdSessionIDs: string[]; promptedSessionIDs: string[]; promptTexts: string[]; messagesCalls: number } {
  const sessionIDs = ["ses_old", "ses_new"];
  const createdSessionIDs: string[] = [];
  const promptedSessionIDs: string[] = [];
  const promptTexts: string[] = [];
  const counters = { messagesCalls: 0 };

  const client = {
    session: {
      create: async () => {
        const id = sessionIDs[createdSessionIDs.length];
        if (id === undefined) throw new Error("unexpected extra session.create");
        createdSessionIDs.push(id);
        return { data: { id } };
      },
      prompt: async (params: { sessionID: string; parts: { type: string; text: string }[] }, options: { signal: AbortSignal }) => {
        promptedSessionIDs.push(params.sessionID);
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        if (params.sessionID === "ses_old") {
          if (mode === "manual") {
            state.restartRequested = true;
            state.restartReason = "manual";
          }
          await waitForAbort(options.signal);
          throw abortError();
        }
        writeIdleContinuationRecord(repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { ses_old: { type: "idle" }, ses_new: { type: "idle" } } }),
      messages: async () => {
        counters.messagesCalls += 1;
        return { data: [] };
      },
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> {
          await waitForAbort(options.signal);
        })(),
      }),
    },
  } as unknown as OpencodeClient;

  return {
    client,
    createdSessionIDs,
    promptedSessionIDs,
    promptTexts,
    get messagesCalls() {
      return counters.messagesCalls;
    },
  };
}

function makeFailureRetryClient({ repoDir }: { repoDir: string }): {
  client: OpencodeClient;
  createdSessionIDs: string[];
  promptTexts: string[];
} {
  const sessionIDs = ["ses_failed", "ses_retry", "ses_done"];
  const createdSessionIDs: string[] = [];
  const promptTexts: string[] = [];

  const client = {
    session: {
      create: async () => {
        const id = sessionIDs[createdSessionIDs.length];
        if (id === undefined) throw new Error("unexpected extra session.create");
        createdSessionIDs.push(id);
        return { data: { id } };
      },
      prompt: async (params: { sessionID: string; parts: { type: string; text: string }[] }) => {
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        if (params.sessionID === "ses_failed") throw new Error("provider rejected request");
        writeIdleContinuationRecord(repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { ses_failed: { type: "idle" }, ses_retry: { type: "idle" }, ses_done: { type: "idle" } } }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> {
          await waitForAbort(options.signal);
        })(),
      }),
    },
  } as unknown as OpencodeClient;

  return { client, createdSessionIDs, promptTexts };
}

describe("clean manual and timeout restarts", () => {
  let scratch: string | undefined;
  const originalRecoveryMaxWait = process.env.LOOPER_SERVER_RECOVERY_MAX_WAIT_MS;
  const originalRecoveryBase = process.env.LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS;
  const originalRecoveryCap = process.env.LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS;

  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
    if (originalRecoveryMaxWait === undefined) delete process.env.LOOPER_SERVER_RECOVERY_MAX_WAIT_MS;
    else process.env.LOOPER_SERVER_RECOVERY_MAX_WAIT_MS = originalRecoveryMaxWait;
    if (originalRecoveryBase === undefined) delete process.env.LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS;
    else process.env.LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS = originalRecoveryBase;
    if (originalRecoveryCap === undefined) delete process.env.LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS;
    else process.env.LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS = originalRecoveryCap;
  });

  function setup(timeout: string): { repoDir: string; configDir: string; state: LoopState } {
    scratch = mkdtempSync(join(tmpdir(), "looper-clean-restart-"));
    const configDir = join(scratch, ".local", "looper");
    mkdirSync(configDir, { recursive: true });
    initStatePaths({ configDir });
    writeFileSync(join(configDir, "build.md"), "build from scratch\n");
    writeFileSync(join(configDir, "looper.yaml"), `steps:\n  build:\n    prompt: build.md\n    timeout: ${timeout}\n`);
    return {
      repoDir: scratch,
      configDir,
      state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }),
    };
  }

  test("manual restart starts a new session instead of resuming the previous session", async () => {
    const { repoDir, configDir, state } = setup("1h");
    const stub = makeRestartClient({ repoDir, state, mode: "manual" });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(stub.createdSessionIDs).toEqual(["ses_old", "ses_new"]);
    expect(stub.promptedSessionIDs).toEqual(["ses_old", "ses_new"]);
    expect(stub.promptTexts[0]).toBe("build from scratch\n");
    expect(stub.promptTexts[0]).not.toContain("previous attempt may have been interrupted");
    expect(stub.promptTexts[1]).toContain("clean restart in a new session");
    expect(stub.promptTexts[1]).toContain("previous attempt may have been interrupted");
    expect(stub.promptTexts[1]).toContain("build from scratch\n");
    expect(stub.messagesCalls).toBe(1);
    expect(state.steps.map((step) => step.sessionID)).toEqual(["ses_old", "ses_new"]);
    expect(state.steps.map((step) => step.restartReason)).toEqual(["manual", undefined]);
    expect(state.steps.map((step) => step.name)).toEqual(["Build", "Build"]);
  });

  test("timeout restart starts a new session instead of resuming the previous session", async () => {
    const { repoDir, configDir, state } = setup("1s");
    const stub = makeRestartClient({ repoDir, state, mode: "timeout" });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(stub.createdSessionIDs).toEqual(["ses_old", "ses_new"]);
    expect(stub.promptedSessionIDs).toEqual(["ses_old", "ses_new"]);
    expect(stub.promptTexts[0]).toBe("build from scratch\n");
    expect(stub.promptTexts[0]).not.toContain("previous attempt may have been interrupted");
    expect(stub.promptTexts[1]).toContain("clean restart in a new session");
    expect(stub.promptTexts[1]).toContain("previous attempt may have been interrupted");
    expect(stub.promptTexts[1]).toContain("build from scratch\n");
    expect(stub.messagesCalls).toBe(1);
    expect(state.steps.map((step) => step.sessionID)).toEqual(["ses_old", "ses_new"]);
    expect(state.steps.map((step) => step.restartReason)).toEqual(["timeout", undefined]);
    expect(state.steps.map((step) => step.name)).toEqual(["Build", "Build"]);
  });

  test("failure retry inserts a new step row and tells the new session where to tail context", async () => {
    const { repoDir, configDir, state } = setup("1h");
    const stub = makeFailureRetryClient({ repoDir });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(stub.createdSessionIDs).toEqual(["ses_failed", "ses_retry"]);
    expect(state.steps.map((step) => step.sessionID)).toEqual(["ses_failed", "ses_retry"]);
    expect(state.steps.map((step) => step.status)).toEqual(["failed", "done"]);
    expect(state.steps.map((step) => step.name)).toEqual(["Build", "Build"]);
    expect(stub.promptTexts[1]).toContain("This is a retry");
    expect(stub.promptTexts[1]).toContain("ses_failed");
    expect(stub.promptTexts[1]).toContain("tail");
    expect(stub.promptTexts[1]).toContain("build from scratch\n");
  }, 15000);

  test("prompt socket loss waits for server recovery and reattaches missed completed session", async () => {
    process.env.LOOPER_SERVER_RECOVERY_MAX_WAIT_MS = "100";
    process.env.LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS = "1";
    process.env.LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS = "1";
    const { repoDir, configDir, state } = setup("1h");
    const createdSessionIDs: string[] = [];
    const promptedSessionIDs: string[] = [];
    const aborts: string[] = [];
    let statusCalls = 0;
    let promptMessageID: string | undefined;

    const client = {
      session: {
        create: async () => {
          createdSessionIDs.push("ses_old");
          return { data: { id: "ses_old" } };
        },
        prompt: async (params: { sessionID: string; messageID: string }) => {
          promptedSessionIDs.push(params.sessionID);
          promptMessageID = params.messageID;
          throw new Error("The socket connection was closed unexpectedly");
        },
        status: async () => {
          statusCalls += 1;
          if (statusCalls <= 2) throw new Error("server busy");
          return { data: { ses_old: { type: "idle" } } };
        },
        messages: async () => {
          if (statusCalls <= 2) throw new Error("server busy");
          writeIdleContinuationRecord(repoDir, "ses_old");
          return {
            data: [
              { info: { id: "msg_prompt", role: "user" }, parts: [] },
              {
                info: { id: "asst", role: "assistant", parentID: promptMessageID, time: { created: 1, completed: 2 } },
                parts: [{ id: "part_text", messageID: "asst", sessionID: "ses_old", type: "text", text: "missed output\n", time: { start: 1, end: 2 } }],
              },
            ],
          };
        },
        children: async () => ({ data: [] }),
        abort: async ({ sessionID }: { sessionID: string }) => {
          aborts.push(sessionID);
          return { data: {} };
        },
      },
      event: {
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
          stream: (async function* (): AsyncGenerator<never> {
            await waitForAbort(options.signal);
          })(),
        }),
      },
    } as unknown as OpencodeClient;

    const result = await runIteration({ state, iteration: 1, client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(createdSessionIDs).toEqual(["ses_old"]);
    expect(promptedSessionIDs).toEqual(["ses_old"]);
    expect(aborts).toEqual([]);
    expect(statusCalls).toBeGreaterThan(2);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]!.status).toBe("done");
    expect(state.steps[0]!.outputLines.some((line) => line.includes("reattaching"))).toBe(true);
    expect(state.steps[0]!.outputLines.some((line) => line.includes("missed output"))).toBe(true);
  });
});
