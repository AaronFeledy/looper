import { describe, expect, test } from "bun:test";
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

import { createPromptEventStream } from "../src/opencode/event-stream.ts";

const SID = "ses_event_stream";

function activityEvent(): Event {
  return { type: "message.updated", properties: { info: { id: "msg_activity", role: "assistant" } } } as unknown as Event;
}

async function* activeStream(signal: AbortSignal): AsyncGenerator<Event> {
  while (!signal.aborted) {
    yield activityEvent();
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
          return { stream: activeStream(options.signal) };
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
});
