import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  assertAttachedServerAgentsLoaded,
  formatAttachedServerAgentRestartPrompt,
} from "../src/lib/attached-server-agents.ts";
import { TITLE_AGENT_NAME } from "../src/lib/title-agent.ts";

function clientWithAgents(agents: Array<{ name: string }>): OpencodeClient {
  return {
    app: {
      agents: async () => ({ data: agents, error: undefined }),
    },
  } as unknown as OpencodeClient;
}

describe("attached server agent validation", () => {
  test("accepts an attached server that already loaded looper-managed agents", async () => {
    await assertAttachedServerAgentsLoaded({
      client: clientWithAgents([{ name: "build" }, { name: TITLE_AGENT_NAME }]),
      repoDir: "/repo",
      serverUrl: "http://127.0.0.1:4096",
    });
  });

  test("prompts for server restart when a looper-managed agent is missing", async () => {
    let message = "";
    try {
      await assertAttachedServerAgentsLoaded({
        client: clientWithAgents([{ name: "build" }]),
        repoDir: "/repo",
        serverUrl: "http://127.0.0.1:4096",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("restart the opencode server");
  });

  test("formats a clear restart prompt", () => {
    expect(
      formatAttachedServerAgentRestartPrompt({
        serverUrl: "http://127.0.0.1:4096",
        missingAgents: [TITLE_AGENT_NAME],
      }),
    ).toContain(`required looper agent: ${TITLE_AGENT_NAME}`);
  });
});
