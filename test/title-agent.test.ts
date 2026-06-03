import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureTitleAgent, TITLE_AGENT_NAME, titleAgentPath } from "../src/lib/title-agent.ts";

describe("ensureTitleAgent", () => {
  let xdg: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    xdg = mkdtempSync(join(tmpdir(), "looper-xdg-"));
    prevXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = xdg;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = prevXdg;
    rmSync(xdg, { recursive: true, force: true });
  });

  test("creates the agent under $XDG_CONFIG_HOME/opencode/agent", () => {
    ensureTitleAgent();
    const file = join(xdg, "opencode", "agent", `${TITLE_AGENT_NAME}.md`);
    expect(titleAgentPath()).toBe(file);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("mode: subagent");
    expect(content).toContain("hidden: true");
  });

  test("omits a variant so no adaptive-thinking variant is attached", () => {
    ensureTitleAgent();
    const content = readFileSync(titleAgentPath(), "utf8");
    expect(content).not.toContain("variant:");
  });

  test("is idempotent: a second call leaves byte-identical content", () => {
    ensureTitleAgent();
    const first = readFileSync(titleAgentPath(), "utf8");
    ensureTitleAgent();
    expect(readFileSync(titleAgentPath(), "utf8")).toBe(first);
  });

  test("refreshes a stale looper-managed file", () => {
    ensureTitleAgent();
    const file = titleAgentPath();
    const managedStale = "---\nmode: subagent\n---\n<!-- managed by looper (looper-title): old -->\nstale\n";
    writeFileSync(file, managedStale);
    ensureTitleAgent();
    expect(readFileSync(file, "utf8")).not.toBe(managedStale);
    expect(readFileSync(file, "utf8")).toContain("hidden: true");
  });

  test("never clobbers a user-authored file lacking the looper marker", () => {
    ensureTitleAgent();
    const file = titleAgentPath();
    const userAuthored = "---\nmode: primary\n---\nmy own title agent\n";
    writeFileSync(file, userAuthored);
    ensureTitleAgent();
    expect(readFileSync(file, "utf8")).toBe(userAuthored);
  });
});
