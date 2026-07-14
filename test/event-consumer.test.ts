import { describe, expect, test } from "bun:test";
import type { Event } from "@opencode-ai/sdk/v2";

import { consumeSessionEvents, createSessionEventConsumer, renderSession } from "../src/lib/event-consumer.ts";
import type {
  PermissionAskedPayload,
  PermissionRepliedPayload,
  QuestionAskedPayload,
  QuestionRejectedPayload,
  QuestionRepliedPayload,
  SessionIdlePayload,
  TodoUpdatedPayload,
} from "../src/lib/event-consumer.ts";

const SID = "ses_test";
const MID = "msg_a";
const PID = "p_1";

async function* makeStream(events: Event[]): AsyncIterable<Event> {
  for (const event of events) yield event;
}

function assistantMessageUpdated(): Event {
  return {
    type: "message.updated",
    properties: { info: { id: MID, role: "assistant" } },
  } as unknown as Event;
}

function assistantMessageErrored(message: string): Event {
  return {
    type: "message.updated",
    properties: { info: { id: MID, role: "assistant", error: { name: "APIError", data: { message } } } },
  } as unknown as Event;
}

function assistantMessageAborted(): Event {
  return {
    type: "message.updated",
    properties: {
      info: { id: MID, role: "assistant", error: { name: "MessageAbortedError", data: { message: "aborted" } } },
    },
  } as unknown as Event;
}

function partDelta(field: string, delta: string): Event {
  return {
    type: "message.part.delta",
    properties: { sessionID: SID, messageID: MID, partID: PID, field, delta },
  } as unknown as Event;
}

function reasoningPartUpdated(text: string): Event {
  return {
    type: "message.part.updated",
    properties: { part: { id: PID, sessionID: SID, messageID: MID, type: "reasoning", text } },
  } as unknown as Event;
}

function textPartUpdated(text: string): Event {
  return {
    type: "message.part.updated",
    properties: { part: { id: PID, sessionID: SID, messageID: MID, type: "text", text } },
  } as unknown as Event;
}

function permissionAsked(id: string, sessionID = SID): Event {
  return {
    type: "permission.asked",
    properties: {
      id,
      sessionID,
      permission: "edit",
      patterns: ["src/**/*.ts"],
      metadata: { filepath: "src/lib/event-consumer.ts" },
      always: ["src/**/*.ts"],
      tool: { messageID: MID, callID: "call_1" },
    },
  } as unknown as Event;
}

function permissionReplied(requestID: string, reply: "once" | "always" | "reject", sessionID = SID): Event {
  return {
    type: "permission.replied",
    properties: { sessionID, requestID, reply },
  } as unknown as Event;
}

function questionAsked(id: string, sessionID = SID): Event {
  return {
    type: "question.asked",
    properties: {
      id,
      sessionID,
      questions: [
        {
          question: "Continue?",
          header: "Continue",
          options: [
            { label: "yes", description: "Proceed" },
            { label: "no", description: "Stop" },
          ],
        },
      ],
      tool: { messageID: MID, callID: "call_2" },
    },
  } as unknown as Event;
}

function questionReplied(requestID: string, sessionID = SID): Event {
  return {
    type: "question.replied",
    properties: { sessionID, requestID, answers: [["yes"]] },
  } as unknown as Event;
}

function questionRejected(requestID: string, sessionID = SID): Event {
  return {
    type: "question.rejected",
    properties: { sessionID, requestID },
  } as unknown as Event;
}

function sessionIdle(sessionID = SID): Event {
  return {
    type: "session.idle",
    properties: { sessionID },
  } as unknown as Event;
}

function todoUpdated(sessionID = SID): Event {
  return {
    type: "todo.updated",
    properties: { sessionID, todos: [{ content: "Wire callbacks", status: "pending", priority: "high" }] },
  } as unknown as Event;
}

describe("request lifecycle callbacks", () => {
  test("surfaces permission, question, idle, and todo events without printing", async () => {
    const lines: string[] = [];
    const permissionsAsked: PermissionAskedPayload[] = [];
    const permissionsReplied: PermissionRepliedPayload[] = [];
    const questionsAsked: QuestionAskedPayload[] = [];
    const questionsReplied: QuestionRepliedPayload[] = [];
    const questionsRejected: QuestionRejectedPayload[] = [];
    const idleSessions: SessionIdlePayload[] = [];
    const todoUpdates: TodoUpdatedPayload[] = [];

    await consumeSessionEvents(
      makeStream([
        permissionAsked("per_1"),
        permissionReplied("per_1", "once"),
        questionAsked("que_1"),
        questionReplied("que_1"),
        questionRejected("que_2"),
        sessionIdle(),
        todoUpdated(),
      ]),
      SID,
      {
        pushLine: (line) => lines.push(line),
        onPermissionAsked: (payload) => permissionsAsked.push(payload),
        onPermissionReplied: (payload) => permissionsReplied.push(payload),
        onQuestionAsked: (payload) => questionsAsked.push(payload),
        onQuestionReplied: (payload) => questionsReplied.push(payload),
        onQuestionRejected: (payload) => questionsRejected.push(payload),
        onSessionIdle: (payload) => idleSessions.push(payload),
        onTodoUpdated: (payload) => todoUpdates.push(payload),
      },
    );

    expect(permissionsAsked).toEqual([
      {
        requestID: "per_1",
        sessionID: SID,
        permission: "edit",
        patterns: ["src/**/*.ts"],
        metadata: { filepath: "src/lib/event-consumer.ts" },
      },
    ]);
    expect(permissionsReplied).toEqual([{ sessionID: SID, requestID: "per_1", reply: "once" }]);
    expect(questionsAsked).toEqual([
      {
        requestID: "que_1",
        sessionID: SID,
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [
              { label: "yes", description: "Proceed" },
              { label: "no", description: "Stop" },
            ],
          },
        ],
      },
    ]);
    expect(questionsReplied).toEqual([{ sessionID: SID, requestID: "que_1", answers: [["yes"]] }]);
    expect(questionsRejected).toEqual([{ sessionID: SID, requestID: "que_2" }]);
    expect(idleSessions).toEqual([{ sessionID: SID }]);
    expect(todoUpdates).toEqual([{ sessionID: SID, todos: [{ content: "Wire callbacks", status: "pending", priority: "high" }] }]);
    expect(lines).toEqual([]);
  });

  test("dedupes asked events by request id across reconnects only", async () => {
    const permissionsAsked: PermissionAskedPayload[] = [];
    const permissionsReplied: PermissionRepliedPayload[] = [];
    const questionsAsked: QuestionAskedPayload[] = [];
    const questionsReplied: QuestionRepliedPayload[] = [];
    const consumer = createSessionEventConsumer(SID, {
      pushLine: () => {},
      onPermissionAsked: (payload) => permissionsAsked.push(payload),
      onPermissionReplied: (payload) => permissionsReplied.push(payload),
      onQuestionAsked: (payload) => questionsAsked.push(payload),
      onQuestionReplied: (payload) => questionsReplied.push(payload),
    });

    await consumer.consume(makeStream([permissionAsked("per_dupe"), questionAsked("que_dupe")]));
    await consumer.consume(
      makeStream([
        permissionAsked("per_dupe"),
        permissionReplied("per_dupe", "once"),
        permissionReplied("per_dupe", "once"),
        questionAsked("que_dupe"),
        questionReplied("que_dupe"),
        questionReplied("que_dupe"),
      ]),
    );

    expect(permissionsAsked.map((payload) => payload.requestID)).toEqual(["per_dupe"]);
    expect(questionsAsked.map((payload) => payload.requestID)).toEqual(["que_dupe"]);
    expect(permissionsReplied.map((payload) => payload.requestID)).toEqual(["per_dupe", "per_dupe"]);
    expect(questionsReplied.map((payload) => payload.requestID)).toEqual(["que_dupe", "que_dupe"]);
  });

  test("applies the existing session filter to callback-only events", async () => {
    let fired = 0;
    await consumeSessionEvents(
      makeStream([
        permissionAsked("per_foreign", "ses_other"),
        permissionReplied("per_foreign", "reject", "ses_other"),
        questionAsked("que_foreign", "ses_other"),
        questionReplied("que_foreign", "ses_other"),
        questionRejected("que_foreign", "ses_other"),
        sessionIdle("ses_other"),
        todoUpdated("ses_other"),
      ]),
      SID,
      {
        pushLine: () => {},
        onPermissionAsked: () => { fired += 1; },
        onPermissionReplied: () => { fired += 1; },
        onQuestionAsked: () => { fired += 1; },
        onQuestionReplied: () => { fired += 1; },
        onQuestionRejected: () => { fired += 1; },
        onSessionIdle: () => { fired += 1; },
        onTodoUpdated: () => { fired += 1; },
      },
    );

    expect(fired).toBe(0);
  });
});

describe("onFirstAssistantContent", () => {
  test('fires on text part.updated', async () => {
    let fired = 0;
    await consumeSessionEvents(makeStream([assistantMessageUpdated(), textPartUpdated("hello")]), SID, {
      pushLine: () => {},
      onFirstAssistantContent: () => { fired += 1; },
    });
    expect(fired).toBe(1);
  });

  test('fires on text delta (field === "text")', async () => {
    let fired = 0;
    await consumeSessionEvents(makeStream([assistantMessageUpdated(), partDelta("text", "hi")]), SID, {
      pushLine: () => {},
      onFirstAssistantContent: () => { fired += 1; },
    });
    expect(fired).toBe(1);
  });

  test('does NOT fire on reasoning part.updated (would snapshot empty session)', async () => {
    let fired = 0;
    await consumeSessionEvents(makeStream([assistantMessageUpdated(), reasoningPartUpdated("thinking")]), SID, {
      pushLine: () => {},
      onFirstAssistantContent: () => { fired += 1; },
    });
    expect(fired).toBe(0);
  });

  test('does NOT fire on reasoning delta (opencode emits field === "reasoning" for reasoning streams)', async () => {
    let fired = 0;
    await consumeSessionEvents(
      makeStream([assistantMessageUpdated(), reasoningPartUpdated(""), partDelta("reasoning", "thinking")]),
      SID,
      {
        pushLine: () => {},
        onFirstAssistantContent: () => { fired += 1; },
      },
    );
    expect(fired).toBe(0);
  });

  test('fires only once across multiple text events', async () => {
    let fired = 0;
    await consumeSessionEvents(
      makeStream([
        assistantMessageUpdated(),
        textPartUpdated("hi"),
        partDelta("text", " there"),
        textPartUpdated("hi there"),
      ]),
      SID,
      {
        pushLine: () => {},
        onFirstAssistantContent: () => { fired += 1; },
      },
    );
    expect(fired).toBe(1);
  });

  test('skips user messages entirely', async () => {
    let fired = 0;
    const userMessage: Event = {
      type: "message.updated",
      properties: { info: { id: "msg_user", role: "user" } },
    } as unknown as Event;
    const userPart: Event = {
      type: "message.part.updated",
      properties: { part: { id: "p_user", sessionID: SID, messageID: "msg_user", type: "text", text: "hello" } },
    } as unknown as Event;
    await consumeSessionEvents(makeStream([userMessage, userPart]), SID, {
      pushLine: () => {},
      onFirstAssistantContent: () => { fired += 1; },
    });
    expect(fired).toBe(0);
  });
});

function toolPartUpdated(status: string, state: Record<string, unknown>): Event {
  return {
    type: "message.part.updated",
    properties: { part: { id: "tool_1", sessionID: SID, messageID: MID, type: "tool", tool: "bash", state: { status, ...state } } },
  } as unknown as Event;
}

describe("tool call line is emitted once per part", () => {
  test("pending(empty) then running(full) then completed yields a single ◌ tool line with full input", async () => {
    const lines: string[] = [];
    await consumeSessionEvents(
      makeStream([
        assistantMessageUpdated(),
        toolPartUpdated("pending", { input: {} }),
        toolPartUpdated("running", { input: { command: "git status" } }),
        toolPartUpdated("completed", { input: { command: "git status" }, output: "clean" }),
      ]),
      SID,
      { pushLine: (line) => lines.push(line) },
    );

    const callLines = lines.filter((line) => line.includes("◌ tool"));
    expect(callLines.length).toBe(1);
    expect(callLines[0]).toContain("git status");
    expect(callLines[0]).not.toContain("{}");
    expect(lines.some((line) => line.includes("Tool output · bash"))).toBe(true);
  });

  test("completed-only (backfill shape) still prints the call line", async () => {
    const lines: string[] = [];
    await consumeSessionEvents(
      makeStream([assistantMessageUpdated(), toolPartUpdated("completed", { input: { command: "ls" }, output: "a\nb" })]),
      SID,
      { pushLine: (line) => lines.push(line) },
    );

    expect(lines.filter((line) => line.includes("◌ tool")).length).toBe(1);
    expect(lines.some((line) => line.includes("Tool output · bash"))).toBe(true);
  });

  test("completed tool output includes retained full-output path metadata", async () => {
    const lines: string[] = [];
    await consumeSessionEvents(
      makeStream([
        assistantMessageUpdated(),
        toolPartUpdated("completed", {
          input: { command: "big" },
          output: "truncated",
          metadata: { outputPath: "/tmp/full-output.txt", outputTruncated: true },
        }),
      ]),
      SID,
      { pushLine: (line) => lines.push(line) },
    );

    expect(lines.some((line) => line.includes("retained full output") && line.includes("/tmp/full-output.txt"))).toBe(true);
  });

  test("pending(empty) then pending(with input) then completed still prints exactly one call line", async () => {
    const lines: string[] = [];
    await consumeSessionEvents(
      makeStream([
        assistantMessageUpdated(),
        toolPartUpdated("pending", { input: {} }),
        toolPartUpdated("pending", { input: { command: "git status" } }),
        toolPartUpdated("completed", { input: { command: "git status" }, output: "clean" }),
      ]),
      SID,
      { pushLine: (line) => lines.push(line) },
    );

    const callLines = lines.filter((line) => line.includes("◌ tool"));
    expect(callLines.length).toBe(1);
    expect(callLines[0]).toContain("git status");
  });
});

describe("assistant message errors", () => {
  test("prints assistant info.error from message.updated", async () => {
    const lines: string[] = [];
    await consumeSessionEvents(makeStream([assistantMessageErrored("provider rejected request")]), SID, {
      pushLine: (line) => lines.push(line),
    });

    expect(lines.some((line) => line.includes("assistant error") && line.includes("APIError") && line.includes("provider rejected request"))).toBe(true);
  });

  test("fires onSessionError for a genuine assistant error", async () => {
    const errors: string[] = [];
    await consumeSessionEvents(makeStream([assistantMessageErrored("provider rejected request")]), SID, {
      pushLine: () => {},
      onSessionError: (message) => errors.push(message),
    });

    expect(errors).toEqual(["APIError: provider rejected request"]);
  });

  test("does not fire onSessionError or print a failure for an aborted assistant message", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    await consumeSessionEvents(makeStream([assistantMessageAborted()]), SID, {
      pushLine: (line) => lines.push(line),
      onSessionError: (message) => errors.push(message),
    });

    expect(errors).toEqual([]);
    expect(lines.some((line) => line.includes("assistant error"))).toBe(false);
  });
});

describe("renderSession timestamps", () => {
  test("stamps events from opencode message/part times, not wall clock", () => {
    const messageCreated = 1_700_000_000_000;
    const textStart = messageCreated + 1_000;
    const toolStart = messageCreated + 5_000;
    const toolEnd = messageCreated + 6_000;

    const { events, eventTimes } = renderSession([
      {
        info: {
          id: "msg_a",
          sessionID: SID,
          role: "assistant",
          time: { created: messageCreated, completed: toolEnd },
          parentID: "msg_u",
          modelID: "gpt",
          providerID: "openai",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "p_text",
            sessionID: SID,
            messageID: "msg_a",
            type: "text",
            text: "hello\n",
            time: { start: textStart, end: textStart + 10 },
          },
          {
            id: "p_tool",
            sessionID: SID,
            messageID: "msg_a",
            type: "tool",
            callID: "call_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "ok",
              title: "bash",
              metadata: {},
              time: { start: toolStart, end: toolEnd },
            },
          },
        ],
      },
    ]);

    const byKind = new Map<string, number[]>();
    events.forEach((event, index) => {
      const times = byKind.get(event.kind) ?? [];
      times.push(eventTimes[index]!);
      byKind.set(event.kind, times);
    });

    expect(byKind.get("assistant.started")).toEqual([textStart]);
    expect(byKind.get("assistant.text")?.[0]).toBe(textStart);
    expect(byKind.get("tool.started")).toEqual([toolStart]);
    expect(byKind.get("tool.done")).toEqual([toolEnd]);

    // Must not collapse everything to "now" (the old history-reload bug).
    const now = Date.now();
    for (const t of eventTimes) {
      expect(Math.abs(t - now)).toBeGreaterThan(60_000);
    }
  });

  test("final flush of unterminated text keeps that part's start, not a later tool end", () => {
    const messageCreated = 1_700_000_200_000;
    const textStart = messageCreated + 1_000;
    const toolStart = messageCreated + 5_000;
    const toolEnd = messageCreated + 6_000;

    const { events, eventTimes, lines, lineTimes } = renderSession([
      {
        info: {
          id: "msg_a",
          sessionID: SID,
          role: "assistant",
          time: { created: messageCreated, completed: toolEnd },
          parentID: "msg_u",
          modelID: "gpt",
          providerID: "openai",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "p_text",
            sessionID: SID,
            messageID: "msg_a",
            type: "text",
            // No trailing newline and no time.end — only final flushRemaining emits this.
            text: "trailing partial",
            time: { start: textStart },
          },
          {
            id: "p_tool",
            sessionID: SID,
            messageID: "msg_a",
            type: "tool",
            callID: "call_1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "ok",
              title: "bash",
              metadata: {},
              time: { start: toolStart, end: toolEnd },
            },
          },
        ],
      },
    ]);

    expect(events.length).toBe(eventTimes.length);
    expect(lines.length).toBe(lineTimes.length);

    const byKind = new Map<string, number[]>();
    events.forEach((event, index) => {
      const times = byKind.get(event.kind) ?? [];
      times.push(eventTimes[index]!);
      byKind.set(event.kind, times);
    });

    expect(byKind.get("assistant.started")).toEqual([textStart]);
    expect(byKind.get("assistant.text")).toEqual([textStart]);
    expect(byKind.get("tool.started")).toEqual([toolStart]);
    expect(byKind.get("tool.done")).toEqual([toolEnd]);

    const textLineIndexes = lines
      .map((line, index) => (line.includes("trailing partial") ? index : -1))
      .filter((index) => index >= 0);
    expect(textLineIndexes.length).toBeGreaterThan(0);
    for (const index of textLineIndexes) {
      expect(lineTimes[index]).toBe(textStart);
    }
  });
});

describe("live/backfill message timestamps", () => {
  test("backfill stamps onEvent times from opencode part times", () => {
    const messageCreated = 1_700_000_100_000;
    const textStart = messageCreated + 2_000;
    const toolStart = messageCreated + 4_000;
    const toolEnd = messageCreated + 5_000;
    const stamped: Array<{ kind: string; at: number }> = [];

    const consumer = createSessionEventConsumer(SID, {
      pushLine: () => {},
      onEvent: (event, at) => {
        stamped.push({ kind: event.kind, at: at ?? -1 });
      },
    });

    consumer.backfill([
      {
        info: {
          id: MID,
          sessionID: SID,
          role: "assistant",
          time: { created: messageCreated, completed: toolEnd },
          parentID: "msg_u",
          modelID: "gpt",
          providerID: "openai",
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "p_text",
            sessionID: SID,
            messageID: MID,
            type: "text",
            text: "hi\n",
            time: { start: textStart, end: textStart + 1 },
          },
          {
            id: "p_tool",
            sessionID: SID,
            messageID: MID,
            type: "tool",
            callID: "c1",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "pwd" },
              output: "/",
              title: "bash",
              metadata: {},
              time: { start: toolStart, end: toolEnd },
            },
          },
        ],
      },
    ]);

    const byKind = new Map(stamped.map((entry) => [entry.kind, entry.at]));
    expect(byKind.get("assistant.started")).toBe(textStart);
    expect(byKind.get("tool.started")).toBe(toolStart);
    expect(byKind.get("tool.done")).toBe(toolEnd);
  });
});
