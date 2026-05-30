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

describe("clean manual and timeout restarts", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
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
    expect(stub.messagesCalls).toBe(0);
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
    expect(stub.messagesCalls).toBe(0);
    expect(state.steps.map((step) => step.sessionID)).toEqual(["ses_old", "ses_new"]);
    expect(state.steps.map((step) => step.restartReason)).toEqual(["timeout", undefined]);
    expect(state.steps.map((step) => step.name)).toEqual(["Build", "Build"]);
  });
});
