import { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { startBackgroundAgentStreamer } from "../src/lib/background-agent-stream.ts";
import { syncStepAgentTree } from "../src/lib/agent-tree-state.ts";
import {
  cancelPendingNotify,
  createLoopState,
  selectStepListRow,
} from "../src/lib/state.ts";

function clientRecordingMessages(calls: string[]): OpencodeClient {
  const client = new OpencodeClient();
  Object.defineProperty(client, "session", {
    value: {
      messages: async ({ sessionID }: { readonly sessionID: string }) => {
        calls.push(sessionID);
        return { data: [] };
      },
    },
  });
  return client;
}

afterEach(() => {
  cancelPendingNotify();
});

describe("startBackgroundAgentStreamer selection", () => {
  test("fetches messages when the selected background row is nested at depth two", async () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    syncStepAgentTree(state, 0, [
      { sessionID: "ses_child", parentSessionID: "ses_root", startedAt: 1, depth: 1, activity: "busy" },
      { sessionID: "ses_grand", parentSessionID: "ses_child", startedAt: 2, depth: 2, activity: "busy" },
    ]);
    selectStepListRow(state, 2);
    const calls: string[] = [];

    // When
    const streamer = startBackgroundAgentStreamer({
      state,
      client: clientRecordingMessages(calls),
      repoDir: "/tmp/looper-background-agent-stream-test",
    });
    await Promise.resolve();

    // Then
    expect(calls).toEqual(["ses_grand"]);
    streamer.stop();
  });

  test("does not fetch messages when the selected session is not a registered background agent", async () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
    state.selectedStepIndex = 0;
    state.selectedBackgroundSessionID = "ses_unknown";
    const calls: string[] = [];

    // When
    const streamer = startBackgroundAgentStreamer({
      state,
      client: clientRecordingMessages(calls),
      repoDir: "/tmp/looper-background-agent-stream-test",
    });
    await Promise.resolve();

    // Then
    expect(calls).toEqual([]);
    streamer.stop();
  });
});
