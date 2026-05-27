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
