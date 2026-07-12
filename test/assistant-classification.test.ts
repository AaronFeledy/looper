import { describe, expect, test } from "bun:test";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { latestUserMessageID } from "../src/opencode/assistant-classification.ts";

type MessageEntry = { info: { id: string; role: string } };

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
