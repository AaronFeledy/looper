import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  applyManagedOpencodeResources,
  assertManagedOpencodeResourcesLoaded,
  checkManagedOpencodeResourcesLoaded,
  formatManagedOpencodeAgentRestartPrompt,
  type ManagedOpencodeResource,
  TITLE_AGENT_NAME,
  TITLE_AGENT_RESOURCE,
  titleAgentPath,
} from "../src/lib/opencode-managed-resources.ts";

function clientWithAgents(agents: Array<{ name: string }>): OpencodeClient {
  return {
    app: {
      agents: async () => ({ data: agents, error: undefined }),
    },
  } as unknown as OpencodeClient;
}

describe("opencode managed resources", () => {
  let xdg: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    xdg = mkdtempSync(join(tmpdir(), "looper-xdg-managed-"));
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = xdg;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    rmSync(xdg, { recursive: true, force: true });
  });

  test("applies the managed title agent resource", () => {
    applyManagedOpencodeResources();
    const file = titleAgentPath();
    expect(readFileSync(file, "utf8")).toContain(TITLE_AGENT_NAME);
    expect(TITLE_AGENT_RESOURCE.isManaged(readFileSync(file, "utf8"))).toBe(true);
  });

  test("is idempotent when the desired title agent content is already present", () => {
    applyManagedOpencodeResources();
    const file = titleAgentPath();
    const firstContent = readFileSync(file, "utf8");
    const firstMtimeMs = statSync(file).mtimeMs;

    applyManagedOpencodeResources();

    expect(readFileSync(file, "utf8")).toBe(firstContent);
    expect(statSync(file).mtimeMs).toBe(firstMtimeMs);
  });

  test("refreshes stale looper-managed title agent content", () => {
    applyManagedOpencodeResources();
    const file = titleAgentPath();
    const managedStale = "---\nmode: subagent\n---\n<!-- managed by looper (looper-title): old -->\nstale\n";
    writeFileSync(file, managedStale);

    applyManagedOpencodeResources();

    expect(readFileSync(file, "utf8")).not.toBe(managedStale);
    expect(readFileSync(file, "utf8")).toBe(TITLE_AGENT_RESOURCE.desiredContent());
  });

  test("keeps user-authored files untouched", () => {
    applyManagedOpencodeResources();
    const file = titleAgentPath();
    const userAuthored = "---\nmode: primary\n---\nmy own title agent\n";
    writeFileSync(file, userAuthored);
    applyManagedOpencodeResources();
    expect(readFileSync(file, "utf8")).toBe(userAuthored);
  });

  test("logs and continues instead of throwing when apply fails", () => {
    const blocker = join(xdg, "blocked");
    writeFileSync(blocker, "not a directory");
    const failingResource: ManagedOpencodeResource = {
      ...TITLE_AGENT_RESOURCE,
      id: "failing-title-agent",
      name: "failing-title-agent",
      targetPath: () => join(blocker, "looper-title.md"),
    };
    const logs: string[] = [];

    expect(() => applyManagedOpencodeResources({ resources: [failingResource], log: (line) => logs.push(line) })).not.toThrow();
    expect(logs.join("\n")).toContain("failed to materialize failing-title-agent");
  });

  test("accepts attached servers that already loaded the managed agent", async () => {
    await assertManagedOpencodeResourcesLoaded({
      client: clientWithAgents([{ name: "build" }, { name: TITLE_AGENT_NAME }]),
      repoDir: "/repo",
      serverUrl: "http://127.0.0.1:4096",
    });
  });

  test("reports missing managed resources without formatting a fatal prompt", async () => {
    const result = await checkManagedOpencodeResourcesLoaded({
      client: clientWithAgents([{ name: "build" }]),
      repoDir: "/repo",
    });

    expect(result.missing.map((resource) => resource.name)).toEqual([TITLE_AGENT_NAME]);
  });

  test("assertion path prompts for restart when a required managed resource is missing", async () => {
    let message = "";
    try {
      await assertManagedOpencodeResourcesLoaded({
        client: clientWithAgents([{ name: "build" }]),
        repoDir: "/repo",
        serverUrl: "http://127.0.0.1:4096",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("restart the opencode server");
  });

  test("assertion path prompts for restart when the server-side check fails", async () => {
    const client = {
      app: {
        agents: async () => ({ data: undefined, error: { message: "server unavailable" } }),
      },
    } as unknown as OpencodeClient;
    let message = "";

    try {
      await assertManagedOpencodeResourcesLoaded({ client, repoDir: "/repo", serverUrl: "http://127.0.0.1:4096" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("failed to check agents");
    expect(message).toContain("restart the opencode server");
  });

  test("formats the restart prompt for missing managed agents", () => {
    expect(
      formatManagedOpencodeAgentRestartPrompt({
        serverUrl: "http://127.0.0.1:4096",
        missingAgents: [TITLE_AGENT_NAME],
      }),
    ).toContain(`required looper agent: ${TITLE_AGENT_NAME}`);
  });
});
