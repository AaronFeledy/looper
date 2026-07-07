import { homedir } from "node:os";
import { join } from "node:path";

export const TITLE_AGENT_NAME = "looper-title";

export const TITLE_AGENT_MARKER = "managed by looper (looper-title)";
const TITLE_AGENT_MARKER_LINE = `<!-- ${TITLE_AGENT_MARKER}: auto-generated; edits will be overwritten. -->`;

/**
 * Tools are fully disabled because the agent is fed a step's work-log as its
 * user message; with tool access a capable model reads it as a task list and
 * starts executing (observed: an 8-minute, ~24-turn opus runaway) instead of
 * emitting one line. `permission` denies backstop any tool the wildcard misses
 * (e.g. MCP/skill tools an attached server loaded before this file refreshed).
 */
export const TITLE_AGENT_CONTENT = `---
description: Looper internal title generator. Hidden; used by looper to title step sessions.
mode: subagent
hidden: true
temperature: 0
tools:
  "*": false
permission:
  "*": deny
  edit: deny
  bash: deny
  webfetch: deny
---
${TITLE_AGENT_MARKER_LINE}

You generate a single, concise thread title for an autonomous coding agent's work log. Output only the title — no preamble, no quotes, no commentary. Never use tools. Looper supplies the full title instructions with each request.
`;

export function titleAgentDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "opencode", "agent");
}

export function titleAgentPath(): string {
  return join(titleAgentDir(), `${TITLE_AGENT_NAME}.md`);
}
