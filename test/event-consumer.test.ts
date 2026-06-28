import { describe, expect, test } from "bun:test";
import type { Event } from "@opencode-ai/sdk/v2";

import { consumeSessionEvents } from "../src/lib/event-consumer.ts";

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
