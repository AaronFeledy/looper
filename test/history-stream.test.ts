import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, test } from "bun:test";

import { startHistoryStreamer } from "../src/lib/history-stream.ts";
import { createLoopState, enterHistoryView, snapshotIterationToHistory } from "../src/lib/state.ts";

describe("history session rendering", () => {
  test("hides only Looper-owned prompts and keeps plugin continuation turns visible", async () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    const step = state.steps[0];
    expect(step).toBeDefined();
    if (step === undefined) return;
    state.iteration = 1;
    step.status = "done";
    step.sessionID = "ses_history";
    step.looperMessageIDs = ["msg_looper"];
    snapshotIterationToHistory(state);
    enterHistoryView(state);

    const client = {
      session: {
        messages: async () => ({
          data: [
            {
              info: { id: "msg_looper", role: "user", time: { created: 1 } },
              parts: [{ id: "p_looper", messageID: "msg_looper", type: "text", text: "secret Looper prompt" }],
            },
            {
              info: { id: "msg_plugin", role: "user", time: { created: 2 } },
              parts: [{ id: "p_plugin", messageID: "msg_plugin", type: "text", text: "visible plugin continuation" }],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const streamer = startHistoryStreamer({ state, client, repoDir: "/repo" });

    await Promise.resolve();
    await Promise.resolve();
    streamer.stop();

    expect(state.historyView?.lines.some((line) => line.includes("secret Looper prompt"))).toBe(false);
    expect(state.historyView?.lines.some((line) => line.includes("visible plugin continuation"))).toBe(true);
  });
});
