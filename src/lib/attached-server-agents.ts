import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  assertManagedOpencodeResourcesLoaded,
  formatManagedOpencodeAgentRestartPrompt,
  ManagedOpencodeResourceError,
  TITLE_AGENT_NAME,
} from "./opencode-managed-resources.ts";

export const REQUIRED_ATTACHED_SERVER_AGENTS = [TITLE_AGENT_NAME] as const;

export { ManagedOpencodeResourceError as AttachedServerAgentError };

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
