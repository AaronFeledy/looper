import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

import { createSessionEventConsumer } from "../src/lib/event-consumer.ts";
import { runIteration } from "../src/lib/orchestrator.ts";
import { reattachOpenCodeStep, runOpenCodeStep, type Step } from "../src/lib/runner.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths } from "../src/lib/state-files.ts";

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

function assistantInProgress(parentID: string): { info: unknown; parts: unknown[] } {
  return {
    info: { id: "msg_in_progress", role: "assistant", parentID, time: { created: Date.now() } },
    parts: [{ id: "prt_tool", messageID: "msg_in_progress", type: "tool", callID: "tool_1" }],
  };
}

function assistantRetryableError(parentID: string): { info: unknown; parts: unknown[] } {
  return {
    info: {
      id: "msg_retryable_error",
      role: "assistant",
      parentID,
      time: { completed: Date.now() },
      error: { name: "APIError", data: { message: "temporary transport failure", isRetryable: true } },
    },
    parts: [],
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

function textPartUpdated(text: string): Event {
  return {
    type: "message.part.updated",
    properties: { part: { id: PID, sessionID: SID, messageID: MID, type: "text", text } },
  } as unknown as Event;
}

function permissionAsked(requestID: string, permission: string, sessionID = SID): Event {
  return {
    type: "permission.asked",
    properties: { id: requestID, sessionID, permission, patterns: ["file.txt"], metadata: { filepath: "file.txt" } },
  } as unknown as Event;
}

function questionAsked(requestID: string, sessionID = SID): Event {
  return {
    type: "question.asked",
    properties: { id: requestID, sessionID, questions: [{ question: "Pick one", options: [{ label: "A" }] }] },
  } as unknown as Event;
}

function todoUpdated(sessionID = SID): Event {
  return {
    type: "todo.updated",
    properties: { sessionID, todos: [{ content: "wire callbacks", status: "in_progress", priority: "high" }] },
  } as unknown as Event;
}

function sessionIdle(sessionID = SID): Event {
  return { type: "session.idle", properties: { sessionID } } as unknown as Event;
}

async function* fromArray(events: Event[]): AsyncGenerator<Event> {
  for (const event of events) yield event;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

describe("runOpenCodeStep headless policy events", () => {
  let repoDir: string | undefined;

  afterEach(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
    repoDir = undefined;
  });

  function makeClient(events: Event[]) {
    let promptMessageID = "";
    const replyCalls: Array<{ requestID: string; reply?: "once" | "always" | "reject"; directory?: string }> = [];
    const questionRejectCalls: Array<{ requestID: string; directory?: string }> = [];
    const questionReplyCalls: Array<{ requestID: string; directory?: string; answers?: unknown[] }> = [];
    const firstReply = deferred();
    const firstQuestionReject = deferred();

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
        subscribe: async () => ({ stream: fromArray(events) }),
      },
      permission: {
        reply: async (params: { requestID: string; reply?: "once" | "always" | "reject"; directory?: string }) => {
          replyCalls.push(params);
          firstReply.resolve();
          return { data: {} };
        },
      },
      question: {
        reject: async (params: { requestID: string; directory?: string }) => {
          questionRejectCalls.push(params);
          firstQuestionReject.resolve();
          return { data: {} };
        },
        reply: async (params: { requestID: string; directory?: string; answers?: unknown[] }) => {
          questionReplyCalls.push(params);
          return { data: {} };
        },
      },
    } as unknown as OpencodeClient;

    return { client, replyCalls, questionRejectCalls, questionReplyCalls, firstReply, firstQuestionReject };
  }

  async function runPolicyStep(params: {
    events: Event[];
    permissionPolicy?: Record<string, "always" | "once" | "reject" | "ask">;
    questionPolicy?: "ask" | "reject";
  }) {
    repoDir = mkdtempSync(join(tmpdir(), "looper-policy-"));
    const continuationDir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(continuationDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(continuationDir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );
    const harness = makeClient(params.events);
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step: Step = { name: "build", prompt: "/tmp/unused-prompt" };

    const result = await runOpenCodeStep({
      state,
      stepIndex: 0,
      prompt: "do the thing",
      client: harness.client,
      repoDir,
      step,
      ...(params.permissionPolicy !== undefined ? { permissionPolicy: params.permissionPolicy } : {}),
      ...(params.questionPolicy !== undefined ? { questionPolicy: params.questionPolicy } : {}),
    });

    await Promise.race([harness.firstReply.promise, harness.firstQuestionReject.promise, Bun.sleep(10)]);
    return { ...harness, state, result, repoDir };
  }

  test("replies with the configured permission action", async () => {
    const run = await runPolicyStep({ events: [permissionAsked("per_allow", "edit")], permissionPolicy: { edit: "always" } });

    expect(run.result.status).toBe("done");
    expect(run.replyCalls).toEqual([{ requestID: "per_allow", reply: "always", directory: run.repoDir }]);
  });

  test("replies with exact once and reject permission actions", async () => {
    const run = await runPolicyStep({
      events: [permissionAsked("per_once", "edit"), permissionAsked("per_reject", "bash")],
      permissionPolicy: { edit: "once", bash: "reject" },
    });

    expect(run.replyCalls).toEqual([
      { requestID: "per_once", reply: "once", directory: run.repoDir },
      { requestID: "per_reject", reply: "reject", directory: run.repoDir },
    ]);
  });

  test("leaves permissions pending when policy is configured but the kind is uncovered", async () => {
    const run = await runPolicyStep({ events: [permissionAsked("per_uncovered", "edit")], permissionPolicy: { bash: "once" } });

    expect(run.replyCalls).toEqual([]);
    expect(run.state.pendingPermission).toBeNull();
    expect(run.state.steps[0]!.outputLines.some((line) => line.includes("permission 'edit' left pending"))).toBe(true);
  });

  test("leaves explicitly ask permissions pending without replying", async () => {
    const run = await runPolicyStep({ events: [permissionAsked("per_ask", "edit")], permissionPolicy: { edit: "ask" } });

    expect(run.replyCalls).toEqual([]);
    expect(run.state.pendingPermission).toBeNull();
    expect(run.state.steps[0]!.outputLines.some((line) => line.includes("permission 'edit' left pending"))).toBe(true);
  });

  test("ignores permission requests when no permission policy is configured", async () => {
    const run = await runPolicyStep({ events: [permissionAsked("per_ignore", "edit")] });

    expect(run.result.status).toBe("done");
    expect(run.replyCalls).toEqual([]);
  });

  test("deduplicates repeated permission request ids", async () => {
    const run = await runPolicyStep({
      events: [permissionAsked("per_dupe", "edit"), permissionAsked("per_dupe", "edit")],
      permissionPolicy: { edit: "always" },
    });

    expect(run.replyCalls).toEqual([{ requestID: "per_dupe", reply: "always", directory: run.repoDir }]);
  });

  test("rejects questions without inventing answers", async () => {
    const run = await runPolicyStep({ events: [questionAsked("que_reject")], questionPolicy: "reject" });

    expect(run.questionRejectCalls).toEqual([{ requestID: "que_reject", directory: run.repoDir }]);
    expect(run.questionReplyCalls).toEqual([]);
  });

  test("leaves ask-policy questions pending without rejecting", async () => {
    const run = await runPolicyStep({ events: [questionAsked("que_ask")], questionPolicy: "ask" });

    expect(run.questionRejectCalls).toEqual([]);
    expect(run.questionReplyCalls).toEqual([]);
    expect(run.state.pendingQuestion).toBeNull();
  });

  test("updates active session todos in state", async () => {
    const run = await runPolicyStep({ events: [todoUpdated()] });

    expect(run.state.todos).toEqual([{ content: "wire callbacks", status: "in_progress", priority: "high" }]);
  });
});

describe("runIteration reattach policy propagation", () => {
  let repoDir: string | undefined;
  let configDir: string | undefined;

  afterEach(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
    if (configDir && configDir !== repoDir) rmSync(configDir, { recursive: true, force: true });
    repoDir = undefined;
    configDir = undefined;
  });

  test("passes permissionPolicy into resume reattach so permissions are auto-approved", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-iter-reattach-repo-"));
    configDir = mkdtempSync(join(tmpdir(), "looper-iter-reattach-config-"));
    const promptPath = join(configDir, "prompt.txt");
    writeFileSync(promptPath, "continue safely\n");
    writeFileSync(join(configDir, "looper.yaml"), `steps:\n  build:\n    prompt: ${promptPath}\n`);
    initStatePaths({ configDir });
    const continuationDir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(continuationDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(continuationDir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );

    const replyCalls: Array<{ requestID: string; reply?: "once" | "always" | "reject"; directory?: string }> = [];
    let statusCalls = 0;
    const client = {
      session: {
        status: async () => {
          statusCalls += 1;
          return { data: { [SID]: { type: statusCalls <= 2 ? "busy" : "idle" } } };
        },
        messages: async () => ({ data: [assistantDone(MID)] }),
        children: async () => ({ data: [] }),
        abort: async () => ({ data: {} }),
      },
      event: {
        subscribe: async () => ({ stream: fromArray([permissionAsked("per_resume_edit", "edit")]) }),
      },
      permission: {
        reply: async (params: { requestID: string; reply?: "once" | "always" | "reject"; directory?: string }) => {
          replyCalls.push(params);
          return { data: {} };
        },
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const result = await runIteration({
      state,
      iteration: 1,
      client,
      repoDir,
      configDir,
      resume: { sessionID: SID, messageID: MID },
      permissionPolicy: { edit: "always" },
    });

    expect(result).toBe("complete");
    expect(replyCalls).toEqual([{ requestID: "per_resume_edit", reply: "always", directory: repoDir }]);
  });

  test("does not start a fresh retry when the tracked assistant turn remains in-progress after the reattach cap", async () => {
    // Given
    repoDir = mkdtempSync(join(tmpdir(), "looper-iter-reattach-cap-repo-"));
    configDir = mkdtempSync(join(tmpdir(), "looper-iter-reattach-cap-config-"));
    const activeRepoDir = repoDir;
    const promptPath = join(configDir, "prompt.txt");
    writeFileSync(promptPath, "continue safely\n");
    writeFileSync(join(configDir, "looper.yaml"), `steps:\n  build:\n    prompt: ${promptPath}\n`);
    initStatePaths({ configDir });
    const createdSessionIDs: string[] = [];
    const promptedSessionIDs: string[] = [];
    let firstMessageID = "";

    const client = {
      session: {
        create: async () => {
          const sessionID = createdSessionIDs.length === 0 ? SID : "ses_fresh_after_cap";
          createdSessionIDs.push(sessionID);
          return { data: { id: sessionID } };
        },
        prompt: async (params: { sessionID: string; messageID: string }) => {
          promptedSessionIDs.push(params.sessionID);
          if (params.sessionID === SID) {
            firstMessageID = params.messageID;
            throw new Error("client disconnected while opencode kept working");
          }
          writeIdleContinuationRecord(activeRepoDir, params.sessionID);
          return { data: {} };
        },
        status: async () => ({ data: { [SID]: { type: "idle" }, ses_fresh_after_cap: { type: "idle" } } }),
        messages: async (params: { sessionID: string }) => ({ data: params.sessionID === SID ? [assistantInProgress(firstMessageID)] : [assistantDone("msg_fresh")] }),
        children: async () => ({ data: [] }),
        abort: async () => ({ data: {} }),
      },
      event: {
        subscribe: async () => ({ stream: fromArray([]) }),
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    let thrown: Error | undefined;

    // When
    try {
      await runIteration({ state, iteration: 1, client, repoDir, configDir });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    // Then
    expect(createdSessionIDs).toEqual([SID]);
    expect(promptedSessionIDs).toEqual([SID]);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain("assistant message still in-progress");
    expect(state.steps[0]?.outputLines.some((line) => line.includes("reattaching (5/5)") && line.includes("assistant message still in-progress"))).toBe(true);
  }, 10000);

  test("gives a fresh failure retry the full step timeout budget after the retry backoff", async () => {
    // Given
    repoDir = mkdtempSync(join(tmpdir(), "looper-iter-retry-budget-repo-"));
    configDir = mkdtempSync(join(tmpdir(), "looper-iter-retry-budget-config-"));
    const activeRepoDir = repoDir;
    const promptPath = join(configDir, "prompt.txt");
    writeFileSync(promptPath, "retry safely\n");
    writeFileSync(join(configDir, "looper.yaml"), `steps:\n  build:\n    prompt: ${promptPath}\n    timeout: 1s\n`);
    initStatePaths({ configDir });
    const createdSessionIDs: string[] = [];
    const promptedSessionIDs: string[] = [];
    let firstMessageID = "";
    let retryPromptAbortedEarly = false;

    const client = {
      session: {
        create: async () => {
          const sessionID = `ses_retry_${createdSessionIDs.length + 1}`;
          createdSessionIDs.push(sessionID);
          return { data: { id: sessionID } };
        },
        prompt: async (params: { sessionID: string; messageID: string }, options: { signal: AbortSignal }) => {
          promptedSessionIDs.push(params.sessionID);
          if (params.sessionID === "ses_retry_1") {
            firstMessageID = params.messageID;
            throw new Error("first prompt failed before opencode finished");
          }
          await Bun.sleep(20);
          retryPromptAbortedEarly = options.signal.aborted;
          if (options.signal.aborted) {
            const error = new Error("retry prompt aborted before it could use its budget");
            error.name = "AbortError";
            throw error;
          }
          writeIdleContinuationRecord(activeRepoDir, params.sessionID);
          return { data: {} };
        },
        status: async () => ({ data: { ses_retry_1: { type: "idle" }, ses_retry_2: { type: "idle" }, ses_retry_3: { type: "idle" } } }),
        messages: async (params: { sessionID: string }) => ({ data: params.sessionID === "ses_retry_1" ? [assistantRetryableError(firstMessageID)] : [assistantDone("msg_retry_success")] }),
        children: async () => ({ data: [] }),
        abort: async () => ({ data: {} }),
      },
      event: {
        subscribe: async () => ({ stream: fromArray([]) }),
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });

    // When
    const result = await runIteration({ state, iteration: 1, client, repoDir, configDir });

    // Then
    expect(result).toBe("complete");
    expect(retryPromptAbortedEarly).toBe(false);
    expect(createdSessionIDs).toEqual(["ses_retry_1", "ses_retry_2"]);
    expect(promptedSessionIDs).toEqual(["ses_retry_1", "ses_retry_2"]);
  }, 10000);

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

  test("reattach restarts with a timeout when the session stays busy past the step timeout", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-reattach-timeout-"));
    let abortCalled = false;

    const client = {
      session: {
        abort: async () => {
          abortCalled = true;
          return { data: {} };
        },
        status: async () => ({ data: { [SID]: { type: "busy" } } }),
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
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
    const startedAt = Date.now();

    const result = await reattachOpenCodeStep({
      state,
      stepIndex: 0,
      client,
      repoDir,
      step,
      sessionID: SID,
      messageID: MID,
    });

    expect(result.status).toBe("restart");
    expect(state.restartRequested).toBe(true);
    expect(state.restartReason).toBe("timeout");
    expect(abortCalled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(state.steps[0]!.outputLines.some((line) => line.includes("reattach exceeded step timeout"))).toBe(true);
  });

  test("reattach clears the reattaching status message once the session streams output", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "looper-reattach-streaming-status-"));
    const continuationDir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(continuationDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(continuationDir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );

    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const statusMessagesAfterStreaming: (string | undefined)[] = [];
    const startedAt = Date.now();

    const client = {
      session: {
        abort: async () => ({ data: {} }),
        status: async () => ({ data: { [SID]: { type: Date.now() - startedAt >= 40 ? "idle" : "busy" } } }),
        messages: async () => ({ data: [assistantDone(MID)] }),
        children: async () => ({ data: [] }),
      },
      event: {
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => {
          const signal = options.signal;
          const stream = (async function* (): AsyncGenerator<Event> {
            yield assistantUpdated();
            yield textPartUpdated("hello\n");
            statusMessagesAfterStreaming.push(state.steps[0]?.statusMessage);
            await new Promise<void>((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })();
          return { stream };
        },
      },
    } as unknown as OpencodeClient;

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

    expect(result.status).toBe("done");
    expect(statusMessagesAfterStreaming).toEqual([undefined]);
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

describe("reattachOpenCodeStep session.idle hints", () => {
  let repoDir: string | undefined;

  afterEach(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
    repoDir = undefined;
  });

  async function runReattachWithIdle(params: { events: Event[]; useSessionIdle?: boolean }) {
    repoDir = mkdtempSync(join(tmpdir(), "looper-reattach-idle-"));
    initStatePaths({ configDir: repoDir });
    const continuationDir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(continuationDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(continuationDir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );
    let statusCalls = 0;
    const startedAt = Date.now();
    let streamAborted = false;

    const client = {
      session: {
        abort: async () => ({ data: {} }),
        status: async () => {
          statusCalls += 1;
          return { data: { [SID]: { type: Date.now() - startedAt >= 40 ? "idle" : "busy" } } };
        },
        messages: async () => ({ data: [assistantDone(MID)] }),
        children: async () => ({ data: [] }),
      },
      event: {
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => {
          const signal = options.signal;
          const stream = (async function* (): AsyncGenerator<Event> {
            await Bun.sleep(50);
            for (const event of params.events) yield event;
            await new Promise<void>((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener(
                "abort",
                () => {
                  streamAborted = true;
                  resolve();
                },
                { once: true },
              );
            });
          })();
          return { stream };
        },
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
      ...(params.useSessionIdle !== undefined ? { useSessionIdle: params.useSessionIdle } : {}),
    });

    return { elapsedMs: Date.now() - startedAt, result, state, statusCalls, streamAborted };
  }

  test("uses active session.idle plus status confirmation to finish reattach promptly", async () => {
    const run = await runReattachWithIdle({ events: [sessionIdle(SID)], useSessionIdle: true });

    expect(run.result.status).toBe("done");
    expect(run.statusCalls).toBeGreaterThanOrEqual(2);
    expect(run.elapsedMs).toBeLessThan(500);
  });

  test("ignores session.idle for a different session during reattach", async () => {
    const run = await runReattachWithIdle({ events: [sessionIdle("ses_other")], useSessionIdle: true });

    expect(run.result.status).toBe("done");
    expect(run.elapsedMs).toBeGreaterThanOrEqual(1_900);
  }, 5000);

  test("ignores session.idle when useSessionIdle is off", async () => {
    const run = await runReattachWithIdle({ events: [sessionIdle(SID)], useSessionIdle: false });

    expect(run.result.status).toBe("done");
    expect(run.elapsedMs).toBeGreaterThanOrEqual(1_900);
  }, 5000);

  test("falls back to polling when no session.idle event arrives", async () => {
    const run = await runReattachWithIdle({ events: [], useSessionIdle: true });

    expect(run.result.status).toBe("done");
    expect(run.elapsedMs).toBeGreaterThanOrEqual(1_900);
  }, 5000);
});
