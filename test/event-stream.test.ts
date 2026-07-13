import { describe, expect, test } from "bun:test";
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

import { createPromptEventStream } from "../src/opencode/event-stream.ts";

const SID = "ses_event_stream";
const OTHER_SID = "ses_other";

function activityEvent(sessionID: string): Event {
  return { type: "message.updated", properties: { sessionID, info: { id: `msg_activity_${sessionID}`, role: "assistant" } } } as unknown as Event;
}

async function* activeStream(signal: AbortSignal, sessionID: string): AsyncGenerator<Event> {
  while (!signal.aborted) {
    yield activityEvent(sessionID);
    await Bun.sleep(5);
  }
}

describe("prompt event stream watchdog", () => {
  test("does not resubscribe while the stream is actively yielding events", async () => {
    let subscribeCount = 0;
    let statusCalls = 0;
    const lines: string[] = [];

    const client = {
      event: {
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => {
          subscribeCount += 1;
          return { stream: activeStream(options.signal, SID) };
        },
      },
      session: {
        status: async () => {
          statusCalls += 1;
          return { data: { [SID]: { type: "busy" } } };
        },
        messages: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient;

    const eventStream = createPromptEventStream({
      client,
      repoDir: "/tmp/looper-event-stream-test",
      sessionID: SID,
      subscription: { ctrl: undefined },
      promptAbortController: new AbortController(),
      cancellationActive: () => false,
      pushLine: (line) => lines.push(line),
      timings: { pollMs: 5, stallThresholdMs: 20, resubscribeBackoffMs: 1 },
      consumer: {
        consume: async (stream) => {
          for await (const _event of stream) {}
        },
        backfill: () => undefined,
        flush: () => undefined,
      },
    });

    await eventStream.start();
    await Bun.sleep(60);
    await eventStream.stop();

    expect(subscribeCount).toBe(1);
    expect(statusCalls).toBe(0);
    expect(lines.some((line) => line.includes("resubscribed"))).toBe(false);
  });

  test("resubscribes when only foreign session events arrive while the target session is busy", async () => {
    let subscribeCount = 0;
    let statusCalls = 0;
    const lines: string[] = [];

    const client = {
      event: {
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => {
          subscribeCount += 1;
          return { stream: activeStream(options.signal, OTHER_SID) };
        },
      },
      session: {
        status: async () => {
          statusCalls += 1;
          return { data: { [SID]: { type: "busy" } } };
        },
        messages: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient;

    const eventStream = createPromptEventStream({
      client,
      repoDir: "/tmp/looper-event-stream-test",
      sessionID: SID,
      subscription: { ctrl: undefined },
      promptAbortController: new AbortController(),
      cancellationActive: () => false,
      pushLine: (line) => lines.push(line),
      timings: { pollMs: 5, stallThresholdMs: 20, resubscribeBackoffMs: 1 },
      consumer: {
        consume: async (stream) => {
          for await (const _event of stream) {}
        },
        backfill: () => undefined,
        flush: () => undefined,
      },
    });

    await eventStream.start();
    await Bun.sleep(60);
    await eventStream.stop();

    expect(statusCalls).toBeGreaterThan(0);
    expect(subscribeCount).toBeGreaterThan(1);
    expect(lines.some((line) => line.includes("resubscribed"))).toBe(true);
  });
});
