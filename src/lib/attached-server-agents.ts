import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  assertManagedOpencodeResourcesLoaded,
  formatManagedOpencodeAgentRestartPrompt,
  ManagedOpencodeResourceError,
  TITLE_AGENT_NAME,
} from "./opencode-managed-resources.ts";

export const REQUIRED_ATTACHED_SERVER_AGENTS = [TITLE_AGENT_NAME] as const;

export { ManagedOpencodeResourceError as AttachedServerAgentError };

export class AttachedServerLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachedServerLocationError";
  }
}

export function formatAttachedServerAgentRestartPrompt({
  serverUrl,
  missingAgents,
}: {
  serverUrl: string;
  missingAgents: readonly string[];
}): string {
  return formatManagedOpencodeAgentRestartPrompt({ serverUrl, missingAgents });
}

export async function assertAttachedServerAgentsLoaded({
  client,
  repoDir,
  serverUrl,
  requiredAgents = REQUIRED_ATTACHED_SERVER_AGENTS,
}: {
  client: OpencodeClient;
  repoDir: string;
  serverUrl: string;
  requiredAgents?: readonly string[];
}): Promise<void> {
  await assertManagedOpencodeResourcesLoaded({ client, repoDir, serverUrl, requiredNames: requiredAgents });
}

export type ConfiguredResourceKind = "agent" | "command" | "skill" | "tool";

type MissingConfiguredResource = {
  kind: ConfiguredResourceKind;
  name: string;
};

function resultError(result: object): unknown {
  return "error" in result ? result.error : undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function missingConfiguredResourcesMessage({ repoDir, missing }: { repoDir: string; missing: readonly MissingConfiguredResource[] }): string {
  return [
    `error: attached opencode server is missing configured resources for ${repoDir}:`,
    "",
    ...missing.map((resource) => `- configured ${resource.kind}: ${resource.name}`),
  ].join("\n");
}

async function readCommandNames(client: OpencodeClient, repoDir: string, signal?: AbortSignal): Promise<Set<string>> {
  let result: Awaited<ReturnType<OpencodeClient["command"]["list"]>>;
  try {
    result = await client.command.list({ directory: repoDir }, signal !== undefined ? { signal } : {});
  } catch (error) {
    throw new ManagedOpencodeResourceError(`failed to check commands: ${formatError(error)}`);
  }

  const error = resultError(result);
  if (error || !result.data) {
    throw new ManagedOpencodeResourceError(`failed to check commands: ${formatError(error)}`);
  }

  return new Set(result.data.map((command) => command.name));
}

async function readSkillNames(client: OpencodeClient, repoDir: string, signal?: AbortSignal): Promise<Set<string>> {
  let result: Awaited<ReturnType<OpencodeClient["app"]["skills"]>>;
  try {
    result = await client.app.skills({ directory: repoDir }, signal !== undefined ? { signal } : {});
  } catch (error) {
    throw new ManagedOpencodeResourceError(`failed to check skills: ${formatError(error)}`);
  }

  const error = resultError(result);
  if (error || !result.data) {
    throw new ManagedOpencodeResourceError(`failed to check skills: ${formatError(error)}`);
  }

  return new Set(result.data.map((skill) => skill.name));
}

async function readAgentNames(client: OpencodeClient, repoDir: string, signal?: AbortSignal): Promise<Set<string>> {
  let result: Awaited<ReturnType<OpencodeClient["app"]["agents"]>>;
  try {
    result = await client.app.agents({ directory: repoDir }, signal !== undefined ? { signal } : {});
  } catch (error) {
    throw new ManagedOpencodeResourceError(`failed to check agents: ${formatError(error)}`);
  }

  const error = resultError(result);
  if (error || !result.data) {
    throw new ManagedOpencodeResourceError(`failed to check agents: ${formatError(error)}`);
  }

  return new Set(result.data.map((agent) => agent.name));
}

async function readToolIds(client: OpencodeClient, repoDir: string, signal?: AbortSignal): Promise<Set<string>> {
  let result: Awaited<ReturnType<OpencodeClient["tool"]["ids"]>>;
  try {
    result = await client.tool.ids({ directory: repoDir }, signal !== undefined ? { signal } : {});
  } catch (error) {
    throw new ManagedOpencodeResourceError(`failed to check tools: ${formatError(error)}`);
  }

  const error = resultError(result);
  if (error || !result.data) {
    throw new ManagedOpencodeResourceError(`failed to check tools: ${formatError(error)}`);
  }

  return new Set(result.data);
}

export async function assertConfiguredResourcesExist({
  client,
  repoDir,
  agents = [],
  commands = [],
  skills = [],
  tools = [],
  signal,
}: {
  client: OpencodeClient;
  repoDir: string;
  agents?: readonly string[];
  commands?: readonly string[];
  skills?: readonly string[];
  tools?: readonly string[];
  signal?: AbortSignal;
}): Promise<void> {
  const missing: MissingConfiguredResource[] = [];

  if (agents.length > 0) {
    const loadedAgents = await readAgentNames(client, repoDir, signal);
    missing.push(...agents.filter((name) => !loadedAgents.has(name)).map((name) => ({ kind: "agent" as const, name })));
  }

  if (commands.length > 0) {
    const loadedCommands = await readCommandNames(client, repoDir, signal);
    missing.push(...commands.filter((name) => !loadedCommands.has(name)).map((name) => ({ kind: "command" as const, name })));
  }

  if (skills.length > 0) {
    const loadedSkills = await readSkillNames(client, repoDir, signal);
    missing.push(...skills.filter((name) => !loadedSkills.has(name)).map((name) => ({ kind: "skill" as const, name })));
  }

  if (tools.length > 0) {
    const loadedTools = await readToolIds(client, repoDir, signal);
    missing.push(...tools.filter((name) => !loadedTools.has(name)).map((name) => ({ kind: "tool" as const, name })));
  }

  if (missing.length === 0) return;
  throw new ManagedOpencodeResourceError(missingConfiguredResourcesMessage({ repoDir, missing }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function directoryFromResult(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const data = result.data;
  if (!isRecord(data)) return undefined;
  const directory = data.directory;
  return typeof directory === "string" && directory.length > 0 ? directory : undefined;
}

async function readDirectoryFromEndpoint(getDirectory: (() => Promise<unknown>) | undefined): Promise<string | undefined> {
  if (getDirectory === undefined) return undefined;
  try {
    return directoryFromResult(await getDirectory());
  } catch {
    return undefined;
  }
}

async function readAttachedDirectory(client: OpencodeClient): Promise<string | undefined> {
  const maybeClient = client as unknown as {
    v2?: { location?: { get?: (parameters?: unknown) => Promise<unknown> } };
    path?: { get?: (parameters?: unknown) => Promise<unknown> };
  };
  const v2Location = maybeClient.v2?.location;
  const v2Get = v2Location?.get;
  const v2Directory = await readDirectoryFromEndpoint(v2Get === undefined ? undefined : () => v2Get());
  if (v2Directory !== undefined) return v2Directory;
  const path = maybeClient.path;
  const pathGet = path?.get;
  return await readDirectoryFromEndpoint(pathGet === undefined ? undefined : () => pathGet());
}

async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    return resolve(directory);
  }
}

export async function assertAttachedServerLocation({
  client,
  repoDir,
  serverUrl,
}: {
  client: OpencodeClient;
  repoDir: string;
  serverUrl: string;
}): Promise<void> {
  const attachedDirectory = await readAttachedDirectory(client);
  if (attachedDirectory === undefined) return;
  const [attachedCanonical, repoCanonical] = await Promise.all([canonicalDirectory(attachedDirectory), canonicalDirectory(repoDir)]);
  if (attachedCanonical === repoCanonical) return;
  throw new AttachedServerLocationError(
    `attached opencode server is using a different directory (${attachedDirectory}) than this Looper repo (${repoDir}); restart or attach to the server for this workspace: ${serverUrl}`,
  );
}
