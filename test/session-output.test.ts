import { describe, expect, test } from "bun:test";

import type { LooperEvent } from "../src/core/events.ts";
import { replaceSessionEvents, type SessionEventBuffer } from "../src/lib/session-output.ts";

describe("replaceSessionEvents", () => {
  test("replaces session events and keeps looper overlay at the end", () => {
    const buffer: SessionEventBuffer = {
      outputEvents: [
        { kind: "assistant.text", text: "stale" },
        { kind: "looper.log", message: "subscribed to events" },
        { kind: "user.text", text: "<!-- OMO_INTERNAL_NOREPLY -->" },
        { kind: "continuation.notice", prefix: "bg", sessionID: "ses_x", state: "active", updatedAt: "t" },
      ],
      outputEventTimes: [1, 2, 3, 4],
    };

    replaceSessionEvents(buffer, {
      events: [
        { kind: "reasoning.text", text: "Both remaining tasks completed." },
        { kind: "assistant.text", text: "Guides are green." },
      ],
      eventTimes: [10, 20],
    });

    const expected: LooperEvent[] = [
      { kind: "reasoning.text", text: "Both remaining tasks completed." },
      { kind: "assistant.text", text: "Guides are green." },
      { kind: "looper.log", message: "subscribed to events" },
      { kind: "continuation.notice", prefix: "bg", sessionID: "ses_x", state: "active", updatedAt: "t" },
    ];
    expect(buffer.outputEvents).toEqual(expected);
    expect(buffer.outputEventTimes).toEqual([10, 20, 2, 4]);
  });
});
