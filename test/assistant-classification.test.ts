import { describe, expect, test } from "bun:test";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  classifyMessagesForCurrentTurn,
  latestUserMessageID,
  latestUserMessageIdFrom,
  resolveOutcomeParentID,
} from "../src/opencode/assistant-classification.ts";

type MessageEntry = { info: { id: string; role: string; parentID?: string; time?: { completed?: number }; cost?: number; tokens?: { output?: number } }; parts?: unknown[] };

function mockClient(result: { error?: unknown; data?: MessageEntry[] } | "throws"): OpencodeClient {
  return {
    session: {
      messages: async () => {
        if (result === "throws") throw new Error("network down");
        return result;
      },
    },
  } as unknown as OpencodeClient;
}

describe("latestUserMessageID", () => {
  test("returns the newest user message id, skipping assistant messages", async () => {
    const client = mockClient({
      data: [
        { info: { id: "msg_user_1", role: "user" } },
        { info: { id: "msg_asst_1", role: "assistant" } },
        { info: { id: "msg_user_2", role: "user" } },
        { info: { id: "msg_asst_2", role: "assistant" } },
      ],
    });
    await expect(latestUserMessageID(client, "/repo", "ses_x")).resolves.toBe("msg_user_2");
  });

  test("returns undefined when there are no user messages", async () => {
    const client = mockClient({ data: [{ info: { id: "msg_asst_1", role: "assistant" } }] });
    await expect(latestUserMessageID(client, "/repo", "ses_x")).resolves.toBeUndefined();
  });

  test("returns undefined on request error or throw", async () => {
    await expect(latestUserMessageID(mockClient({ error: { message: "boom" } }), "/repo", "ses_x")).resolves.toBeUndefined();
    await expect(latestUserMessageID(mockClient("throws"), "/repo", "ses_x")).resolves.toBeUndefined();
  });
});

describe("classifyMessagesForCurrentTurn", () => {
  test("treats any open assistant as in-progress even if the original prompt is done", () => {
    const messages = [
      { info: { id: "msg_prompt", role: "user" } },
      {
        info: { id: "msg_first", role: "assistant", parentID: "msg_prompt", time: { completed: 1 }, cost: 1, tokens: { output: 2 } },
        parts: [{ type: "text", text: "done" }],
      },
      { info: { id: "msg_omo", role: "user" } },
      { info: { id: "msg_open", role: "assistant", parentID: "msg_omo", time: {} }, parts: [{ type: "text", text: "working" }] },
    ];
    expect(latestUserMessageIdFrom(messages)).toBe("msg_omo");
    expect(classifyMessagesForCurrentTurn(messages, "msg_prompt")).toEqual({ kind: "in-progress" });
  });

  test("classifies against the latest user parent once every assistant has completed", () => {
    const messages = [
      { info: { id: "msg_prompt", role: "user" } },
      {
        info: { id: "msg_first", role: "assistant", parentID: "msg_prompt", time: { completed: 1 }, cost: 1, tokens: { output: 2 } },
        parts: [{ type: "text", text: "first" }],
      },
      { info: { id: "msg_omo", role: "user" } },
      {
        info: { id: "msg_later", role: "assistant", parentID: "msg_omo", time: { completed: 2 }, cost: 1, tokens: { output: 4 } },
        parts: [{ type: "text", text: "later" }],
      },
    ];
    expect(classifyMessagesForCurrentTurn(messages, "msg_prompt")).toEqual({ kind: "done" });
  });
});

describe("resolveOutcomeParentID", () => {
  test("keeps the fallback when the latest user turn has no assistant children", () => {
    const messages = [
      { info: { id: "msg_sent", role: "user" } },
      {
        info: { id: "msg_asst", role: "assistant", parentID: "msg_sent", time: { completed: 1 }, cost: 1, tokens: { output: 2 } },
        parts: [{ type: "text", text: "done" }],
      },
      { info: { id: "msg_label_only", role: "user" } },
    ];
    expect(resolveOutcomeParentID(messages, "msg_sent")).toBe("msg_sent");
  });
});
