import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  assertAttachedServerAgentsLoaded,
  assertAttachedServerLocation,
  assertConfiguredResourcesExist,
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

function clientWithResources({
  agents = [],
  commands,
  skills,
  tools,
}: {
  agents?: Array<{ name: string }>;
  commands: Array<{ name: string }>;
  skills: Array<{ name: string; location: string; content: string }>;
  tools: string[];
}): OpencodeClient {
  return {
    app: {
      agents: async () => ({ data: agents, error: undefined }),
      skills: async () => ({ data: skills, error: undefined }),
    },
    command: {
      list: async () => ({ data: commands, error: undefined }),
    },
    tool: {
      ids: async () => ({ data: tools, error: undefined }),
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

  test("rejects attached server location mismatches when location data is available", async () => {
    const client = {
      v2: {
        location: {
          get: async () => ({ data: { directory: "/other", project: { id: "project", directory: "/other" } } }),
        },
      },
    } as unknown as OpencodeClient;

    let message = "";
    try {
      await assertAttachedServerLocation({ client, repoDir: "/repo", serverUrl: "http://127.0.0.1:4096" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("attached opencode server is using a different directory");
    expect(message).toContain("/other");
    expect(message).toContain("/repo");
  });

  test("falls back to legacy path location when v2 location throws", async () => {
    const client = {
      v2: {
        location: {
          get: async () => {
            throw new Error("v2 location unavailable");
          },
        },
      },
      path: {
        get: async () => ({ data: { directory: "/other" } }),
      },
    } as unknown as OpencodeClient;

    let message = "";
    try {
      await assertAttachedServerLocation({ client, repoDir: "/repo", serverUrl: "http://127.0.0.1:4096" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("attached opencode server is using a different directory");
    expect(message).toContain("/other");
  });

  test("accepts matching attached server locations through symlinks", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "looper-attach-location-"));
    try {
      const repoDir = join(scratch, "repo");
      const linkedRepoDir = join(scratch, "repo-link");
      mkdirSync(repoDir);
      symlinkSync(repoDir, linkedRepoDir, "dir");
      const client = {
        v2: {
          location: {
            get: async () => ({ data: { directory: linkedRepoDir } }),
          },
        },
      } as unknown as OpencodeClient;

      await assertAttachedServerLocation({ client, repoDir, serverUrl: "http://127.0.0.1:4096" });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("configured resource validation", () => {
  test("accepts configured agents that are loaded on the attached server", async () => {
    await assertConfiguredResourcesExist({
      client: clientWithResources({
        agents: [{ name: "build" }, { name: "reviewer" }],
        commands: [],
        skills: [],
        tools: [],
      }),
      repoDir: "/repo",
      agents: ["build", "reviewer"],
    });
  });

  test("rejects configured step agents missing from the attached server", async () => {
    let message = "";
    try {
      await assertConfiguredResourcesExist({
        client: clientWithResources({
          agents: [{ name: "build" }],
          commands: [],
          skills: [],
          tools: [],
        }),
        repoDir: "/repo",
        agents: ["missing-agent"],
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("configured agent: missing-agent");
  });

  test("accepts configured commands, skills, and tools that are loaded on the attached server", async () => {
    await assertConfiguredResourcesExist({
      client: clientWithResources({
        commands: [{ name: "ship" }],
        skills: [{ name: "review-work", location: "builtin", content: "" }],
        tools: ["bash", "edit"],
      }),
      repoDir: "/repo",
      commands: ["ship"],
      skills: ["review-work"],
      tools: ["bash"],
    });
  });

  test("rejects configured command, skill, and tool references missing from the attached server", async () => {
    let message = "";
    try {
      await assertConfiguredResourcesExist({
        client: clientWithResources({
          commands: [{ name: "ship" }],
          skills: [{ name: "review-work", location: "builtin", content: "" }],
          tools: ["bash"],
        }),
        repoDir: "/repo",
        commands: ["missing-command"],
        skills: ["missing-skill"],
        tools: ["missing-tool"],
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("configured command: missing-command");
    expect(message).toContain("configured skill: missing-skill");
    expect(message).toContain("configured tool: missing-tool");
  });
});
