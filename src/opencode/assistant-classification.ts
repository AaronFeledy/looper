import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import type { AssistantClassification } from "../core/session-types.ts";
import { isRecord, stringValue } from "./util.ts";

export type { AssistantClassification } from "../core/session-types.ts";

export function assistantErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const name = stringValue(error.name) ?? "Error";
  const data = isRecord(error.data) ? error.data : null;
  const message = data && "message" in data ? String(data.message) : stringValue(error.message);
  return message === undefined || message === name ? name : `${name}: ${message}`;
}

export function isNonRetryableAssistantError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const data = isRecord(error.data) ? error.data : null;
  return data?.isRetryable === false;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function assistantHasMeaningfulActivity(entry: { info: unknown; parts?: unknown[] }): boolean {
  const info = isRecord(entry.info) ? entry.info : {};
  const tokens = isRecord(info.tokens) ? info.tokens : {};
  if (numberValue(info.cost) > 0 || numberValue(tokens.output) > 0 || numberValue(tokens.reasoning) > 0) return true;

  const parts = Array.isArray(entry.parts) ? entry.parts : [];
  return parts.some((part) => {
    if (!isRecord(part)) return false;
    const type = part.type;
    if (type === "text" || type === "reasoning") return stringValue(part.text) !== undefined;
    return type === "tool" || type === "file" || type === "patch";
  });
}

export function emptyAssistantMessage(messageID: string): string {
  return `assistant message ${messageID} completed without assistant output or tool activity`;
}

/**
 * ID of the newest user message in a session, or undefined when it cannot be
 * determined. Used after opencode's continuation hook re-prompts a session
 * itself: the resumed turn's assistant messages parent that hook's user
 * message, not looper's original prompt.
 */
export async function latestUserMessageID(
  client: OpencodeClient,
  repoDir: string,
  sessionID: string,
): Promise<string | undefined> {
  let result;
  try {
    result = await client.session.messages({ sessionID, directory: repoDir });
  } catch {
    return undefined;
  }
  if (result.error || !result.data) return undefined;
  let latest: string | undefined;
  for (const entry of result.data) {
    if (entry.info.role !== "user") continue;
    latest = stringValue(entry.info.id) ?? latest;
  }
  return latest;
}

export async function classifyAssistantForMessage(
  client: OpencodeClient,
  repoDir: string,
  sessionID: string,
  parentMessageID: string,
): Promise<AssistantClassification> {
  let result;
  try {
    result = await client.session.messages({ sessionID, directory: repoDir });
  } catch {
    return { kind: "missing" };
  }
  if (result.error || !result.data) return { kind: "missing" };
  let tracked: AssistantClassification | undefined;
  let terminalError: AssistantClassification | undefined;
  for (const entry of result.data) {
    const info = entry.info;
    if (info.role !== "assistant") continue;
    const error = (info as { error?: unknown }).error;
    const errorMessage = assistantErrorMessage(error);
    if (errorMessage !== undefined && isNonRetryableAssistantError(error)) {
      terminalError ??= { kind: "failed", errorMessage };
    }
    if (info.parentID !== parentMessageID) continue;
    if (errorMessage !== undefined) {
      tracked = { kind: "failed", errorMessage };
      continue;
    }
    if (info.time.completed !== undefined) {
      if (assistantHasMeaningfulActivity(entry)) {
        tracked = { kind: "done" };
      } else if (tracked?.kind !== "done") {
        tracked = { kind: "empty", errorMessage: emptyAssistantMessage(stringValue(info.id) ?? parentMessageID) };
      }
    } else {
      tracked = { kind: "in-progress" };
    }
  }
  if (terminalError !== undefined) return terminalError;
  return tracked ?? { kind: "missing" };
}
