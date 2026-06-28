import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { resolve } from "node:path";

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

async function readAttachedDirectory(client: OpencodeClient): Promise<string | undefined> {
  const maybeClient = client as unknown as {
    v2?: { location?: { get?: (parameters?: unknown) => Promise<unknown> } };
    path?: { get?: (parameters?: unknown) => Promise<unknown> };
  };
  try {
    const v2Get = maybeClient.v2?.location?.get;
    if (v2Get !== undefined) {
      const result = await v2Get();
      const directory = directoryFromResult(result);
      if (directory !== undefined) return directory;
    }
  } catch {
    return undefined;
  }
  try {
    const pathGet = maybeClient.path?.get;
    if (pathGet === undefined) return undefined;
    return directoryFromResult(await pathGet());
  } catch {
    return undefined;
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
  if (resolve(attachedDirectory) === resolve(repoDir)) return;
  throw new AttachedServerLocationError(
    `attached opencode server is using a different directory (${attachedDirectory}) than this Looper repo (${repoDir}); restart or attach to the server for this workspace: ${serverUrl}`,
  );
}
