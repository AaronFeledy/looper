import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

export const TITLE_AGENT_NAME = "looper-title";
export const DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS = 10_000;

const TITLE_AGENT_MARKER = "managed by looper (looper-title)";
const TITLE_AGENT_MARKER_LINE = `<!-- ${TITLE_AGENT_MARKER}: auto-generated; edits will be overwritten. -->`;

/**
 * Tools are fully disabled because the agent is fed a step's work-log as its
 * user message; with tool access a capable model reads it as a task list and
 * starts executing (observed: an 8-minute, ~24-turn opus runaway) instead of
 * emitting one line. `permission` denies backstop any tool the wildcard misses
 * (e.g. MCP/skill tools an attached server loaded before this file refreshed).
 */
const TITLE_AGENT_CONTENT = `---
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

export type ManagedOpencodeResourceKind = "agent" | "skill" | "tool" | "mcp" | "plugin";

export type ManagedOpencodeResource = {
  id: string;
  kind: ManagedOpencodeResourceKind;
  criticality: "required" | "best-effort";
  name: string;
  targetPath: () => string;
  desiredContent: () => string;
  isManaged: (content: string) => boolean;
  applyFailureHint?: string;
};

export const TITLE_AGENT_RESOURCE: ManagedOpencodeResource = {
  id: TITLE_AGENT_NAME,
  kind: "agent",
  criticality: "required",
  name: TITLE_AGENT_NAME,
  targetPath: titleAgentPath,
  desiredContent: () => TITLE_AGENT_CONTENT,
  isManaged: (content) => content.includes(TITLE_AGENT_MARKER),
  applyFailureHint: "titles may be skipped",
};

export const LOOPER_MANAGED_RESOURCES = [TITLE_AGENT_RESOURCE] as const;

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function configuredAttachValidationTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs !== undefined) return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS;
  const raw = process.env["LOOPER_ATTACH_VALIDATION_TIMEOUT_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS;
}

function formatDuration(ms: number): string {
  return ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`;
}

function timeoutMessage({ serverUrl, repoDir, timeoutMs }: { serverUrl: string; repoDir: string; timeoutMs: number }): string {
  return [
    `error: attached opencode server at ${serverUrl} did not respond while validating required agents for ${repoDir} (timed out after ${formatDuration(timeoutMs)}).`,
    "",
    "Please restart the opencode server, then launch looper again.",
  ].join("\n");
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeOut = false;
  let disposed = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error(`timed out after ${formatDuration(timeoutMs)}`));
  }, timeoutMs);
  timer.unref?.();

  const abortFromParent = () => controller.abort(parent?.reason ?? new Error("operation aborted"));
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
    timedOut: () => didTimeOut,
  };
}

function resultError(result: object): unknown {
  return "error" in result ? result.error : undefined;
}

export class ManagedOpencodeResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedOpencodeResourceError";
  }
}

export type ManagedOpencodeResourceCheckResult = {
  missing: ManagedOpencodeResource[];
};

export function titleAgentDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "opencode", "agent");
}

export function titleAgentPath(): string {
  return join(titleAgentDir(), `${TITLE_AGENT_NAME}.md`);
}

function resourcePath(resource: ManagedOpencodeResource): string {
  return resource.targetPath();
}

function writeResourceAtomically(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, content);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function applyManagedOpencodeResources({
  resources = LOOPER_MANAGED_RESOURCES,
  log,
}: {
  resources?: readonly ManagedOpencodeResource[];
  log?: (line: string) => void;
} = {}): void {
  for (const resource of resources) {
    const file = resourcePath(resource);
    const desiredContent = resource.desiredContent();
    try {
      let existing: string | undefined;
      try {
        existing = readFileSync(file, "utf8");
      } catch {
        existing = undefined;
      }

      if (existing !== undefined) {
        if (!resource.isManaged(existing)) {
          log?.(`[looper] ${resource.kind}: ${file} exists and is not looper-managed; leaving it untouched`);
          continue;
        }
        if (existing === desiredContent) continue;
      }

      mkdirSync(dirname(file), { recursive: true });
      writeResourceAtomically(file, desiredContent);
      log?.(`[looper] ${resource.kind}: ${existing === undefined ? "created" : "refreshed"} ${file}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = resource.applyFailureHint ?? "resource may be unavailable";
      log?.(`[looper] ${resource.kind}: failed to materialize ${resource.name} (${message}); ${hint}`);
    }
  }
}

export function ensureTitleAgent(opts?: { log?: (line: string) => void }): void {
  applyManagedOpencodeResources({ resources: [TITLE_AGENT_RESOURCE], log: opts?.log });
}

export function formatManagedOpencodeAgentRestartPrompt({
  serverUrl,
  missingAgents,
}: {
  serverUrl: string;
  missingAgents: readonly string[];
}): string {
  const names = missingAgents.join(", ");
  return [
    `error: attached opencode server at ${serverUrl} has not loaded required looper agent${missingAgents.length === 1 ? "" : "s"}: ${names}`,
    "",
    "Looper installed/refreshed its managed agent files on disk, but an already-running opencode server does not reload them for this client connection.",
    "Please restart the opencode server, then launch looper again.",
  ].join("\n");
}

export function assertManagedOpencodeResourcesLoaded({
  client,
  repoDir,
  serverUrl,
  resources = LOOPER_MANAGED_RESOURCES,
  requiredNames,
  signal,
  timeoutMs,
}: {
  client: OpencodeClient;
  repoDir: string;
  serverUrl: string;
  resources?: readonly ManagedOpencodeResource[];
  requiredNames?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  return assertLoadedResources({ client, repoDir, serverUrl, resources, requiredNames, signal, timeoutMs });
}

export async function checkManagedOpencodeResourcesLoaded({
  client,
  repoDir,
  resources = LOOPER_MANAGED_RESOURCES,
  signal,
}: {
  client: OpencodeClient;
  repoDir: string;
  resources?: readonly ManagedOpencodeResource[];
  signal?: AbortSignal;
}): Promise<ManagedOpencodeResourceCheckResult> {
  const requiredAgentResources = resources.filter((resource) => resource.kind === "agent" && resource.criticality === "required");
  if (requiredAgentResources.length === 0) return { missing: [] };

  let result: Awaited<ReturnType<OpencodeClient["app"]["agents"]>>;
  try {
    result = await client.app.agents({ directory: repoDir }, { signal });
  } catch (error) {
    throw new ManagedOpencodeResourceError(`failed to check agents: ${formatError(error)}`);
  }

  const error = resultError(result);
  if (error || !result.data) {
    throw new ManagedOpencodeResourceError(`failed to check agents: ${formatError(error)}`);
  }

  const loaded = new Set(result.data.map((agent) => agent.name));
  return { missing: requiredAgentResources.filter((resource) => !loaded.has(resource.name)) };
}

async function assertLoadedResources({
  client,
  repoDir,
  serverUrl,
  resources,
  requiredNames,
  signal,
  timeoutMs,
}: {
  client: OpencodeClient;
  repoDir: string;
  serverUrl: string;
  resources: readonly ManagedOpencodeResource[];
  requiredNames?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  const filteredResources = requiredNames === undefined ? resources : resources.filter((resource) => requiredNames.includes(resource.name));
  const validationTimeoutMs = configuredAttachValidationTimeoutMs(timeoutMs);
  const validationSignal = timeoutSignal(signal, validationTimeoutMs);

  let result: ManagedOpencodeResourceCheckResult;
  try {
    result = await checkManagedOpencodeResourcesLoaded({ client, repoDir, resources: filteredResources, signal: validationSignal.signal });
  } catch (error) {
    if (validationSignal.timedOut()) {
      throw new ManagedOpencodeResourceError(timeoutMessage({ serverUrl, repoDir, timeoutMs: validationTimeoutMs }));
    }
    throw new ManagedOpencodeResourceError(
      `error: failed to check agents on attached opencode server at ${serverUrl}: ${formatError(error)}\n\nPlease restart the opencode server, then launch looper again.`,
    );
  } finally {
    validationSignal.dispose();
  }

  const missingAgents = result.missing.filter((resource) => resource.kind === "agent").map((resource) => resource.name);
  if (missingAgents.length === 0) return;

  throw new ManagedOpencodeResourceError(formatManagedOpencodeAgentRestartPrompt({ serverUrl, missingAgents }));
}
