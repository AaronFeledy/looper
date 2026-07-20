import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ContextPolicy } from "../src/lib/config.ts";
import { runIteration, StepFailureError, type ResumeSession } from "../src/lib/orchestrator.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";

// allow: SIZE_OK — the characterization matrix and its shared SDK harness form one refactor guard.

const CONTEXT_OFF: ContextPolicy = {
  datetime: false,
  repoDir: false,
  loopPosition: false,
  timebox: false,
  vcsDelta: false,
  sessionIds: false,
  prd: false,
  story: false,
};

type TestMessage = {
  readonly info: Record<string, unknown>;
  readonly parts: readonly Record<string, unknown>[];
};

type HarnessOptions = {
  readonly sessionIDs?: readonly string[];
  readonly prompt?: (input: { readonly sessionID: string; readonly messageID: string; readonly call: number }) => Promise<void>;
  readonly status?: (call: number) => Promise<Record<string, { readonly type: "idle" | "busy" | "retry" }>>;
  readonly messages?: (input: { readonly sessionID: string; readonly call: number }) => Promise<readonly TestMessage[]>;
  readonly abort?: (input: { readonly sessionID: string; readonly call: number }) => Promise<void>;
  readonly eventError?: string;
};

type Harness = {
  readonly client: OpencodeClient;
  readonly calls: string[];
  readonly promptMessageIDs: Map<string, string>;
};

const scratchDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setupScratch(): { repoDir: string; configDir: string; state: LoopState } {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-step-attempt-"));
  scratchDirs.push(repoDir);
  const configDir = join(repoDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  writeFileSync(join(configDir, "build.md"), "build from scratch\n");
  writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    timeout: 1h\n");
  return { repoDir, configDir, state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }) };
}

function abortableStream(signal: AbortSignal): AsyncGenerator<never> {
  return (async function* (): AsyncGenerator<never> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  })();
}

function continuationPath(repoDir: string, sessionID: string): string {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionID}.json`);
}

function writeContinuation(repoDir: string, sessionID: string, state: "active" | "idle", stale = false): void {
  const updatedAt = new Date(Date.now() - (stale ? 20 * 60 * 1_000 : 0)).toISOString();
  writeFileSync(
    continuationPath(repoDir, sessionID),
    JSON.stringify({
      sessionID,
      updatedAt,
      sources: {
        "background-task": {
          state,
          ...(state === "active" ? { reason: "characterization background task" } : {}),
          updatedAt,
        },
      },
    }),
  );
}

function assistantDone(parentID: string, sessionID: string, id = "asst_done"): TestMessage {
  return {
    info: { id, role: "assistant", parentID, time: { created: 1, completed: 2 }, tokens: { output: 1 } },
    parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text: "done" }],
  };
}

function assistantEmpty(parentID: string, id = "asst_empty"): TestMessage {
  return {
    info: { id, role: "assistant", parentID, time: { created: 1, completed: 2 }, tokens: { output: 0 } },
    parts: [],
  };
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const sessionIDs = options.sessionIDs ?? ["ses_1", "ses_2", "ses_3", "ses_4"];
  const calls: string[] = [];
  const promptMessageIDs = new Map<string, string>();
  let createCalls = 0;
  let promptCalls = 0;
  let statusCalls = 0;
  let messageCalls = 0;
  let abortCalls = 0;

  const client: OpencodeClient = Object.assign(Object.create(null), {
    session: {
      create: async () => {
        const id = sessionIDs[createCalls];
        if (id === undefined) throw new Error("unexpected extra session.create");
        createCalls += 1;
        calls.push(`create:${id}`);
        return { data: { id } };
      },
      prompt: async (params: { sessionID: string; messageID: string }) => {
        promptCalls += 1;
        calls.push(`prompt:${params.sessionID}`);
        promptMessageIDs.set(params.sessionID, params.messageID);
        await options.prompt?.({ sessionID: params.sessionID, messageID: params.messageID, call: promptCalls });
        return { data: {} };
      },
      status: async () => {
        statusCalls += 1;
        calls.push(`status:${statusCalls}`);
        const data = options.status === undefined
          ? Object.fromEntries(sessionIDs.map((id) => [id, { type: "idle" as const }]))
          : await options.status(statusCalls);
        return { data };
      },
      messages: async ({ sessionID }: { sessionID: string }) => {
        messageCalls += 1;
        calls.push(`messages:${sessionID}:${messageCalls}`);
        return { data: options.messages === undefined ? [] : await options.messages({ sessionID, call: messageCalls }) };
      },
      children: async ({ sessionID }: { sessionID: string }) => {
        calls.push(`children:${sessionID}`);
        return { data: [] };
      },
      abort: async ({ sessionID }: { sessionID: string }) => {
        abortCalls += 1;
        calls.push(`abort:${sessionID}`);
        await options.abort?.({ sessionID, call: abortCalls });
        return { data: {} };
      },
    },
    event: {
      subscribe: async (_params: unknown, eventOptions: { signal: AbortSignal }) => ({
        stream: options.eventError === undefined
          ? abortableStream(eventOptions.signal)
          : (async function* () {
              yield {
                type: "session.error",
                properties: { sessionID: "ses_1", error: { message: options.eventError } },
              };
            })(),
      }),
    },
  });

  return { client, calls, promptMessageIDs };
}

async function execute(
  input: ReturnType<typeof setupScratch>,
  harness: Harness,
  resume?: ResumeSession,
): Promise<"complete" | "stopped"> {
  return await runIteration({
    state: input.state,
    iteration: 1,
    client: harness.client,
    repoDir: input.repoDir,
    configDir: input.configDir,
    ...(resume !== undefined ? { resume } : {}),
    contextPolicy: CONTEXT_OFF,
  });
}

async function captureFailure(run: Promise<"complete" | "stopped">): Promise<StepFailureError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof StepFailureError) return error;
    throw error;
  }
  throw new Error("expected runIteration to throw StepFailureError");
}

function expectExactLog(state: LoopState, line: string): void {
  expect(state.agentLines).toContain(line);
}

describe("runIteration fail-path characterization", () => {
  beforeEach(() => {
    for (const key of [
      "LOOPER_STOP_SESSION_TIMEOUT_MS",
      "LOOPER_SERVER_RECOVERY_MAX_WAIT_MS",
      "LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS",
      "LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS",
      "LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS",
    ]) {
      savedEnv.set(key, process.env[key]);
    }
    process.env.LOOPER_STOP_SESSION_TIMEOUT_MS = "5";
    process.env.LOOPER_SERVER_RECOVERY_MAX_WAIT_MS = "3";
    process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS = "1";
    process.env.LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS = "1";
    process.env.LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS = "1";
  });

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  test("(a) unconfirmed resume stop fails closed and suppresses retry", async () => {
    // Given
    const input = setupScratch();
    const harness = makeHarness({ status: async () => ({ ses_old: { type: "busy" } }) });

    // When
    const error = await captureFailure(execute(input, harness, { sessionID: "ses_old", stepName: "Other" }));

    // Then
    const reason = "could not confirm session ses_old stopped; not restarting after resume to avoid overlapping opencode generations";
    expect(error.message).toBe(`Build failed after 0 retries: ${reason}`);
    expect(input.state.steps.map((row) => row.status)).toEqual(["failed"]);
    expect(harness.calls.filter((call) => call.startsWith("create:"))).toEqual([]);
    expectExactLog(input.state, `[looper] ${reason}`);
    expectExactLog(input.state, `[looper] Build failed: ${reason} — not retrying: retry suppressed (${reason})`);
  });

  test("(b) unrecovered server leaves the terminal session running", async () => {
    // Given
    const input = setupScratch();
    const harness = makeHarness({
      prompt: async () => {
        throw new Error("socket lost");
      },
      status: async () => {
        throw new Error("server unavailable");
      },
    });

    // When
    const error = await captureFailure(execute(input, harness));

    // Then
    const reason = "server did not recover while checking session ses_1; leaving the session alone so it can complete in the background";
    expect(error.message).toBe(`Build failed after 0 retries: ${reason}`);
    expect(input.state.steps.map((row) => row.status)).toEqual(["failed"]);
    expect(harness.calls.filter((call) => call === "abort:ses_1")).toEqual([]);
    expectExactLog(input.state, `[looper] ${reason}`);
    expectExactLog(input.state, "[looper] Build: session ses_1 may still be running after terminal failure");
  });

  test("(c) active prior session fails closed when the reattach cap is reached", async () => {
    // Given
    const input = setupScratch();
    const harness = makeHarness({
      prompt: async () => {
        throw new Error("socket lost");
      },
      eventError: "reattach transport failed",
      status: async () => ({ ses_1: { type: "idle" } }),
      messages: async ({ sessionID }) => {
        const parentID = harness.promptMessageIDs.get(sessionID) ?? "missing";
        return [assistantDone(parentID, sessionID)];
      },
    });

    // When
    const error = await captureFailure(execute(input, harness));

    // Then
    const reason = "reattach limit (5) reached after assistant message completed server-side";
    expect(error.message).toBe(`Build failed after 0 retries: ${reason}`);
    expect(input.state.steps.map((row) => row.status)).toEqual(["failed"]);
    expect(input.state.agentLines.filter((line) => line.startsWith("[looper] Build reattaching (")).length).toBe(5);
    expectExactLog(input.state, `[looper] ${reason}; leaving session ses_1 alone so it can complete`);
  }, 30_000);

  test("(d) a second orphaned-background nudge fails at the one-nudge cap", async () => {
    // Given
    const input = setupScratch();
    let transitionRecord = false;
    const harness = makeHarness({
      sessionIDs: ["ses_bg"],
      prompt: async ({ sessionID }) => {
        writeContinuation(input.repoDir, sessionID, "active");
        transitionRecord = true;
      },
      status: async () => {
        if (transitionRecord) {
          transitionRecord = false;
          writeContinuation(input.repoDir, "ses_bg", "active", true);
        }
        return { ses_bg: { type: "idle" } };
      },
    });

    // When
    const error = await captureFailure(execute(input, harness));

    // Then
    expect(error.message).toBe("Build failed after 0 retries: background marker still orphaned after nudge for session ses_bg");
    expect(input.state.steps.map((row) => row.status)).toEqual(["failed"]);
    expect(harness.calls.filter((call) => call === "prompt:ses_bg")).toHaveLength(2);
    expectExactLog(input.state, "[looper] background marker orphaned; nudging session ses_bg to verify and finish");
    expectExactLog(input.state, "[looper] background marker still orphaned after nudge; failing closed for session ses_bg");
  }, 10_000);

  test("(e) eleven background resumptions fail at the ten-resume cap", async () => {
    // Given
    const input = setupScratch();
    let transitionRecord = false;
    const harness = makeHarness({
      sessionIDs: ["ses_bg"],
      prompt: async ({ sessionID }) => {
        writeContinuation(input.repoDir, sessionID, "active");
        transitionRecord = true;
      },
      status: async () => {
        if (transitionRecord) {
          transitionRecord = false;
          writeContinuation(input.repoDir, "ses_bg", "idle");
        }
        return { ses_bg: { type: "idle" } };
      },
    });

    // When
    const error = await captureFailure(execute(input, harness));

    // Then
    expect(error.message).toBe("Build failed after 0 retries: background task resume limit (10) exceeded for session ses_bg");
    expect(input.state.steps.map((row) => row.status)).toEqual(["failed"]);
    expect(harness.calls.filter((call) => call === "prompt:ses_bg")).toHaveLength(11);
    expectExactLog(input.state, "[looper] background task resume limit exceeded for session ses_bg");
  }, 15_000);

  test("(f) three failed fresh sessions exhaust two failure retries", async () => {
    // Given
    const input = setupScratch();
    const harness = makeHarness({
      sessionIDs: ["ses_1", "ses_2", "ses_3"],
      prompt: async ({ sessionID }) => {
        throw new Error(`provider rejected ${sessionID}`);
      },
    });

    // When
    const error = await captureFailure(execute(input, harness));

    // Then
    expect(error.message).toBe("Build failed after 2 retries: provider rejected ses_3");
    expect(input.state.steps.map((row) => row.status)).toEqual(["failed", "failed", "failed"]);
    expect(harness.calls.filter((call) => call.startsWith("create:"))).toEqual(["create:ses_1", "create:ses_2", "create:ses_3"]);
    expectExactLog(input.state, "[looper] Build failed: provider rejected ses_3 — not retrying: retry limit reached (2)");
  }, 15_000);

  test("(g) no fresh session is created until the prior resume session is confirmed idle", async () => {
    // Given
    const input = setupScratch();
    let aborted = false;
    const harness = makeHarness({
      sessionIDs: ["ses_new"],
      abort: async ({ sessionID }) => {
        if (sessionID === "ses_old") aborted = true;
      },
      status: async () => {
        if (!aborted) return { ses_old: { type: "busy" }, ses_new: { type: "idle" } };
        return { ses_old: { type: "idle" }, ses_new: { type: "idle" } };
      },
      prompt: async ({ sessionID }) => writeContinuation(input.repoDir, sessionID, "idle"),
    });

    // When
    const result = await execute(input, harness, { sessionID: "ses_old", stepName: "Other" });

    // Then
    expect(result).toBe("complete");
    expect(input.state.steps.map((row) => row.status)).toEqual(["done"]);
    expect(harness.calls.indexOf("create:ses_new")).toBeGreaterThan(harness.calls.indexOf("status:2"));
    expect(harness.calls.indexOf("abort:ses_old")).toBeLessThan(harness.calls.indexOf("create:ses_new"));
    expectExactLog(input.state, "[looper] resuming Build: step changed since the session was recorded; confirming session ses_old is stopped before restarting");
  });

  test("(h1) interrupted health wait by restart becomes a clean restart attempt", async () => {
    // Given
    const input = setupScratch();
    let statusCalls = 0;
    const harness = makeHarness({
      sessionIDs: ["ses_new"],
      status: async () => {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error("server unavailable");
        if (statusCalls === 2) {
          input.state.restartRequested = true;
          input.state.restartReason = "manual";
          throw new Error("server unavailable");
        }
        return { ses_old: { type: "idle" }, ses_new: { type: "idle" } };
      },
      prompt: async ({ sessionID }) => writeContinuation(input.repoDir, sessionID, "idle"),
    });

    // When
    const result = await execute(input, harness, { sessionID: "ses_old", messageID: "msg_old", stepName: "Build" });

    // Then
    expect(result).toBe("complete");
    expect(input.state.steps.map((row) => row.status)).toEqual(["done", "done"]);
    expect(input.state.steps.map((row) => row.restartReason)).toEqual(["manual", undefined]);
    expect(harness.calls).toContain("create:ses_new");
    expectExactLog(input.state, "[looper] server health check stopped by manual restart request for session ses_old");
  });

  test("(h2) interrupted health wait by quitting stops and leaves the row skipped", async () => {
    // Given
    const input = setupScratch();
    let statusCalls = 0;
    const harness = makeHarness({
      status: async () => {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error("server unavailable");
        if (statusCalls === 2) {
          input.state.quitting = true;
          throw new Error("server unavailable");
        }
        return { ses_old: { type: "idle" } };
      },
    });

    // When
    const result = await execute(input, harness, { sessionID: "ses_old", messageID: "msg_old", stepName: "Build" });

    // Then
    expect(result).toBe("stopped");
    expect(input.state.steps.map((row) => row.status)).toEqual(["skipped"]);
    expect(harness.calls.filter((call) => call.startsWith("create:"))).toEqual([]);
    expectExactLog(input.state, "[looper] stop requested while checking session ses_old");
    expectExactLog(input.state, "[looper] Build failed: stop requested while checking session ses_old — not retrying: stop requested");
  });

  test("(h3) interrupted health wait by skip resolves as skipped", async () => {
    // Given
    const input = setupScratch();
    let statusCalls = 0;
    const harness = makeHarness({
      status: async () => {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error("server unavailable");
        input.state.skipRequested = true;
        throw new Error("server unavailable");
      },
    });

    // When
    const result = await execute(input, harness, { sessionID: "ses_old", messageID: "msg_old", stepName: "Build" });

    // Then
    expect(result).toBe("complete");
    expect(input.state.steps.map((row) => row.status)).toEqual(["skipped"]);
    expect(harness.calls.filter((call) => call.startsWith("create:"))).toEqual([]);
    expectExactLog(input.state, "[looper] server health check stopped for session ses_old");
  });

  test("(i) a failed prompt reattaches to the completed prior session", async () => {
    // Given
    const input = setupScratch();
    writeContinuation(input.repoDir, "ses_1", "idle");
    const harness = makeHarness({
      prompt: async () => {
        throw new Error("socket lost after dispatch");
      },
      status: async () => ({ ses_1: { type: "idle" } }),
      messages: async ({ sessionID }) => {
        const parentID = harness.promptMessageIDs.get(sessionID) ?? "missing";
        return [assistantDone(parentID, sessionID)];
      },
    });

    // When
    const result = await execute(input, harness);

    // Then
    expect(result).toBe("complete");
    expect(input.state.steps.map((row) => row.status)).toEqual(["done"]);
    expect(harness.calls.filter((call) => call.startsWith("create:"))).toEqual(["create:ses_1"]);
    expectExactLog(input.state, "[looper] Build reattaching (1/5) to session ses_1 — assistant message completed server-side despite client error");
    expect(input.state.agentLines.some((line) => line.startsWith("[looper] reattach: assistant message ") && line.endsWith(" completed cleanly"))).toBe(true);
  });

  test("(j) empty assistant classification becomes the retry reason before recovery", async () => {
    // Given
    const input = setupScratch();
    const harness = makeHarness({
      sessionIDs: ["ses_empty", "ses_retry"],
      prompt: async ({ sessionID }) => {
        if (sessionID === "ses_retry") writeContinuation(input.repoDir, sessionID, "idle");
      },
      messages: async ({ sessionID }) => {
        const parentID = harness.promptMessageIDs.get(sessionID) ?? "missing";
        return sessionID === "ses_empty" ? [assistantEmpty(parentID)] : [];
      },
    });

    // When
    const result = await execute(input, harness);

    // Then
    expect(result).toBe("complete");
    expect(input.state.steps.map((row) => row.status)).toEqual(["failed", "done"]);
    expect(harness.calls.filter((call) => call.startsWith("create:"))).toEqual(["create:ses_empty", "create:ses_retry"]);
    const reason = `assistant message asst_empty completed without assistant output or tool activity`;
    expectExactLog(input.state, `[looper] Build failed: ${reason} — waiting 2s before retry (attempt 1/2); will retry with a fresh session`);
  }, 10_000);

  test("(k1) a running prior session is stopped and confirmed before fresh retry", async () => {
    // Given
    const input = setupScratch();
    let promptFailed = false;
    let evaluationStatusSeen = false;
    let aborted = false;
    const harness = makeHarness({
      sessionIDs: ["ses_old", "ses_retry"],
      prompt: async ({ sessionID }) => {
        if (sessionID === "ses_old") {
          promptFailed = true;
          throw new Error("request failed");
        }
        writeContinuation(input.repoDir, sessionID, "idle");
      },
      messages: async () => [],
      abort: async ({ sessionID }) => {
        if (sessionID === "ses_old") aborted = true;
      },
      status: async () => {
        if (promptFailed && !evaluationStatusSeen) {
          evaluationStatusSeen = true;
          return { ses_old: { type: "idle" }, ses_retry: { type: "idle" } };
        }
        return {
          ses_old: { type: aborted ? "idle" : promptFailed ? "busy" : "idle" },
          ses_retry: { type: "idle" },
        };
      },
    });

    // When
    const result = await execute(input, harness);

    // Then
    expect(result).toBe("complete");
    expect(input.state.steps.map((row) => row.status)).toEqual(["failed", "done"]);
    expect(harness.calls.indexOf("abort:ses_old")).toBeLessThan(harness.calls.indexOf("create:ses_retry"));
    expectExactLog(input.state, "[looper] Build: prior session ses_old still pending; aborting before retrying in a fresh session");
  }, 10_000);

  test("(k2) an unconfirmed running prior session blocks the fresh retry", async () => {
    // Given
    const input = setupScratch();
    let promptFailed = false;
    let evaluationStatusSeen = false;
    const harness = makeHarness({
      sessionIDs: ["ses_old", "ses_retry"],
      prompt: async () => {
        promptFailed = true;
        throw new Error("request failed");
      },
      messages: async () => [],
      status: async () => {
        if (promptFailed && !evaluationStatusSeen) {
          evaluationStatusSeen = true;
          return { ses_old: { type: "idle" }, ses_retry: { type: "idle" } };
        }
        return { ses_old: { type: promptFailed ? "busy" : "idle" }, ses_retry: { type: "idle" } };
      },
    });

    // When
    const error = await captureFailure(execute(input, harness));

    // Then
    const reason = "could not confirm session ses_old stopped; not retrying in a fresh session to avoid overlapping opencode generations";
    expect(error.message).toBe(`Build failed after 0 retries: ${reason}`);
    expect(input.state.steps.map((row) => row.status)).toEqual(["failed"]);
    expect(harness.calls).not.toContain("create:ses_retry");
    expectExactLog(input.state, `[looper] ${reason}`);
  }, 10_000);

  test("(l) a fresh retry inserts a second row and completes end-to-end", async () => {
    // Given
    const input = setupScratch();
    const harness = makeHarness({
      sessionIDs: ["ses_failed", "ses_retry"],
      prompt: async ({ sessionID }) => {
        if (sessionID === "ses_failed") throw new Error("provider rejected request");
        writeContinuation(input.repoDir, sessionID, "idle");
      },
    });

    // When
    const result = await execute(input, harness);

    // Then
    expect(result).toBe("complete");
    expect(input.state.steps.map((row) => row.status)).toEqual(["failed", "done"]);
    expect(harness.calls.filter((call) => call.startsWith("create:"))).toEqual(["create:ses_failed", "create:ses_retry"]);
    expectExactLog(input.state, "[looper] Build failed: provider rejected request — waiting 2s before retry (attempt 1/2); will retry with a fresh session");
    expectExactLog(input.state, "[looper] Build retrying now (attempt 1/2)");
  }, 10_000);
});
