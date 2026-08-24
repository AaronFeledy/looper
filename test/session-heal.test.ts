import { describe, expect, test } from "bun:test";

import { createSessionEventConsumer, renderSession } from "../src/lib/event-consumer.ts";
import { eventsToOutputBlocks } from "../src/presentation/tui/stream-blocks.ts";
import { classifyMessagesForCurrentTurn, latestUserMessageIdFrom } from "../src/opencode/assistant-classification.ts";

const PROMPT_ID = "msg_looper_prompt";
const OMO_ID = "msg_02c86f8e9001L2i2ZuBQov86pn";

function userEntry(id: string, text: string, created: number) {
  return {
    info: { id, role: "user" as const, time: { created } } as never,
    parts: [{ id: `p_${id}`, messageID: id, type: "text" as const, text, time: { start: created, end: created } } as never],
  };
}

function assistantEntry(id: string, parentID: string, text: string, created: number, completed?: number) {
  return {
    info: {
      id,
      role: "assistant" as const,
      parentID,
      time: completed === undefined ? { created } : { created, completed },
    } as never,
    parts: [{ id: `p_${id}`, messageID: id, type: "text" as const, text, time: { start: created, end: completed ?? created } } as never],
  };
}

describe("session heal characterization", () => {
  test("renderSession does not emit leftover OMO markers as a User block after later reasoning", () => {
    const omoTurns = Array.from({ length: 17 }, (_, index) => {
      const marker = index % 4 === 1 ? "<!-- OMO_INTERNAL_INITIATOR -->" : "<!-- OMO_INTERNAL_NOREPLY -->";
      return userEntry(
        `msg_omo_${index}`,
        `<system-reminder>\nBackground task ${index} ready.\n</system-reminder>\n${marker}`,
        1_700_000_000_000 + index,
      );
    });
    const rendered = renderSession([
      userEntry(PROMPT_ID, "original looper prompt", 1_700_000_000_000 - 1_000),
      ...omoTurns,
      {
        info: { id: "msg_reason", role: "assistant", parentID: OMO_ID, time: { created: 1_700_000_100_000, completed: 1_700_000_100_100 } } as never,
        parts: [
          {
            id: "p_reason",
            messageID: "msg_reason",
            type: "reasoning",
            text: "Both remaining tasks completed. Collect results and then run Wave 5 gates.",
            time: { start: 1_700_000_100_000, end: 1_700_000_100_100 },
          } as never,
        ],
      },
      assistantEntry("msg_tail", OMO_ID, "US-585 is implemented on the contract branch.", 1_700_000_200_000, 1_700_000_200_500),
    ], new Set([PROMPT_ID]));

    const blocks = eventsToOutputBlocks(rendered.events, rendered.eventTimes);
    const userBlocks = blocks.filter((block) => block.kind === "group" && block.title === "User");
    const userText = userBlocks.flatMap((block) => (block.kind === "group" ? block.lines : [])).join("\n");
    expect(userText.includes("OMO_INTERNAL")).toBe(false);
    expect(userText).toContain("Background task");
    expect(rendered.events.some((event) => event.kind === "assistant.text" && event.text.includes("US-585"))).toBe(true);
  });

  test("flush after a live user tail does not append marker-only user.text after reasoning", () => {
    const events: Array<{ kind: string; text?: string }> = [];
    const consumer = createSessionEventConsumer("ses_heal", {
      pushLine: () => undefined,
      onEvent: (event) => {
        events.push(event);
      },
    });

    consumer.backfill([
      {
        info: { id: "msg_user", role: "user", time: { created: 10 } } as never,
        parts: [
          {
            id: "p_user",
            messageID: "msg_user",
            type: "text",
            text: "<system-reminder>\nAll sibling background tasks are complete.\n</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->",
          } as never,
        ],
      },
      {
        info: { id: "msg_reason", role: "assistant", time: { created: 20 } } as never,
        parts: [
          {
            id: "p_reason",
            messageID: "msg_reason",
            type: "reasoning",
            text: "Both remaining tasks completed.",
          } as never,
        ],
      },
    ]);
    consumer.flush();

    const afterReasoning = events
      .map((event) => event.kind)
      .join(",");
    expect(afterReasoning.includes("reasoning.text")).toBe(true);
    expect(events.filter((event) => event.kind === "user.text").every((event) => event.kind === "user.text" && event.text !== undefined && !event.text.includes("OMO_INTERNAL"))).toBe(true);
    const lastUserIndex = events.map((event) => event.kind).lastIndexOf("user.text");
    const firstReasoningIndex = events.map((event) => event.kind).indexOf("reasoning.text");
    if (lastUserIndex !== -1 && firstReasoningIndex !== -1) {
      expect(lastUserIndex).toBeLessThan(firstReasoningIndex);
    }
  });

  test("current-turn classification follows the latest user parent, not the original prompt", () => {
    const messages = [
      { info: { id: PROMPT_ID, role: "user" } },
      {
        info: { id: "msg_first", role: "assistant", parentID: PROMPT_ID, time: { created: 1, completed: 2 }, cost: 1, tokens: { output: 4 } },
        parts: [{ type: "text", text: "first wave" }],
      },
      { info: { id: OMO_ID, role: "user" } },
      {
        info: { id: "msg_open", role: "assistant", parentID: OMO_ID, time: { created: 3 } },
        parts: [{ type: "text", text: "still working" }],
      },
    ];

    expect(latestUserMessageIdFrom(messages)).toBe(OMO_ID);
    expect(classifyMessagesForCurrentTurn(messages, PROMPT_ID)).toEqual({ kind: "in-progress" });

    const firstUser = messages[0];
    const firstAssistant = messages[1];
    const omoUser = messages[2];
    if (firstUser === undefined || firstAssistant === undefined || omoUser === undefined) throw new Error("fixture");
    const finished = [
      firstUser,
      firstAssistant,
      omoUser,
      {
        info: { id: "msg_done", role: "assistant", parentID: OMO_ID, time: { created: 3, completed: 4 }, cost: 1, tokens: { output: 8 } },
        parts: [{ type: "text", text: "US-585 is implemented" }],
      },
    ];
    expect(classifyMessagesForCurrentTurn(finished, PROMPT_ID)).toEqual({ kind: "done" });
  });
});
