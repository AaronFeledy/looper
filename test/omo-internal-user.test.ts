import { describe, expect, test } from "bun:test";

import { renderSession } from "../src/lib/event-consumer.ts";
import {
  isOmoInternalOnlyText,
  isOmoInternalOnlyUserMessage,
  orderMessagesForRender,
  stripOmoInternalMarkers,
  visibleUserText,
} from "../src/lib/omo-internal-user.ts";

describe("omo internal user markers", () => {
  test("detects marker-only control turns", () => {
    const text = [
      "<!-- OMO_INTERNAL_INITIATOR -->",
      "<!-- OMO_INTERNAL_NOREPLY -->",
      "<!-- OMO_INTERNAL_NOREPLY -->",
      "<!-- OMO_INTERNAL_INITIATOR -->",
    ].join("\n");
    expect(isOmoInternalOnlyText(text)).toBe(true);
    expect(stripOmoInternalMarkers(`real prompt\n${text}`).trim()).toBe("real prompt");
  });

  test("visibleUserText keeps the body and drops control markers", () => {
    expect(visibleUserText("do the work\n<!-- OMO_INTERNAL_INITIATOR -->")).toBe("do the work");
    expect(visibleUserText("<!-- OMO_INTERNAL_NOREPLY -->")).toBe("");
  });

  test("classifies marker-only user messages", () => {
    expect(
      isOmoInternalOnlyUserMessage({
        info: { role: "user" },
        parts: [{ type: "text", text: "<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_INTERNAL_NOREPLY -->" }],
      }),
    ).toBe(true);
    expect(
      isOmoInternalOnlyUserMessage({
        info: { role: "user" },
        parts: [{ type: "text", text: "do the work\n<!-- OMO_INTERNAL_INITIATOR -->" }],
      }),
    ).toBe(false);
  });

  test("moves open assistants after trailing OMO-only user turns", () => {
    const ordered = orderMessagesForRender([
      {
        info: { role: "assistant", time: { created: 1 } },
        parts: [{ type: "text", text: "still streaming" }],
      },
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_INTERNAL_NOREPLY -->" }],
      },
    ]);

    expect(ordered.map((entry) => entry.info.role)).toEqual(["user", "assistant"]);
  });

  test("keeps completed assistants above trailing OMO turns", () => {
    const ordered = orderMessagesForRender([
      {
        info: { role: "assistant", time: { created: 1, completed: 2 } },
        parts: [{ type: "text", text: "done" }],
      },
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "<!-- OMO_INTERNAL_NOREPLY -->" }],
      },
    ]);

    expect(ordered.map((entry) => entry.info.role)).toEqual(["assistant", "user"]);
  });

  test("offline rendering hides marker-only turns and strips markers from bodies", () => {
    const rendered = renderSession([
      {
        info: { id: "msg_done", role: "assistant", time: { created: 1, completed: 2 } } as never,
        parts: [{ id: "p_done", messageID: "msg_done", type: "text", text: "finished work", time: { end: 2 } } as never],
      },
      {
        info: { id: "msg_open", role: "assistant", time: { created: 3 } } as never,
        parts: [{ id: "p_open", messageID: "msg_open", type: "text", text: "still going" } as never],
      },
      {
        info: { id: "msg_omo", role: "user", time: { created: 4 } } as never,
        parts: [
          {
            id: "p_omo",
            messageID: "msg_omo",
            type: "text",
            text: "<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_INTERNAL_NOREPLY -->",
            time: { end: 4 },
          } as never,
        ],
      },
      {
        info: { id: "msg_body", role: "user", time: { created: 5 } } as never,
        parts: [
          {
            id: "p_body",
            messageID: "msg_body",
            type: "text",
            text: "<system-reminder>\nAll sibling background tasks are complete.\n</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->",
            time: { end: 5 },
          } as never,
        ],
      },
    ]);

    const texts = rendered.events
      .filter((event): event is { kind: "assistant.text" | "user.text"; text: string } =>
        event.kind === "assistant.text" || event.kind === "user.text",
      )
      .map((event) => event.text);

    expect(texts.some((text) => text.includes("OMO_INTERNAL"))).toBe(false);
    expect(texts).toContain("finished work");
    expect(texts).toContain("still going");
    expect(texts.join("\n")).toContain("All sibling background tasks are complete.");
  });
});
