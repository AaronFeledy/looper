import type { Message, Part } from "@opencode-ai/sdk/v2";
import { visibleUserText } from "./omo-internal-user.ts";

export type SessionMessageSnapshot = { info: Message; parts: Part[] };
export type SessionInspection = {
  sessionID: string;
  status: "loading" | "ready" | "error";
  error?: string;
  observedAt?: number;
  metadata?: {
    messageID: string;
    source: "reported" | "requested";
    agent?: string;
    model?: string;
    variant?: string;
    variantSource?: "reported" | "requested";
    cost?: number;
    tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
    finish?: string;
  };
};

function ordered(messages: readonly SessionMessageSnapshot[]): SessionMessageSnapshot[] {
  return [...messages].sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0) || a.info.id.localeCompare(b.info.id));
}

/** A newer request must not inherit a previous turn's model or variant. */
export function inspectSessionMessages(
  sessionID: string,
  messages: readonly SessionMessageSnapshot[],
  observedAt = Date.now(),
): SessionInspection {
  const sorted = ordered(messages.filter((message) => message.info.sessionID === sessionID));
  const info = sorted.at(-1)?.info;
  if (!info) return { sessionID, status: "ready", observedAt };
  if (info.role === "user") {
    return { sessionID, status: "ready", observedAt, metadata: {
      messageID: info.id, source: "requested", agent: info.agent,
      model: info.model?.providerID && info.model.modelID ? `${info.model.providerID}/${info.model.modelID}` : undefined,
      variant: info.model?.variant, variantSource: info.model?.variant === undefined ? undefined : "requested",
    } };
  }
  const parent = sorted.find((message) => message.info.role === "user" && message.info.id === info.parentID)?.info;
  const requestedVariant = parent?.role === "user" ? parent.model?.variant : undefined;
  return { sessionID, status: "ready", observedAt, metadata: {
    messageID: info.id, source: "reported", agent: info.agent,
    model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined,
    variant: info.variant ?? requestedVariant,
    variantSource: info.variant !== undefined ? "reported" : requestedVariant !== undefined ? "requested" : undefined,
    cost: info.cost,
    tokens: info.tokens ? { input: info.tokens.input, output: info.tokens.output, reasoning: info.tokens.reasoning, cacheRead: info.tokens.cache.read, cacheWrite: info.tokens.cache.write } : undefined,
    finish: info.finish,
  } };
}

/** The original user turn of a fully fetched child transcript, not a recent continuation. */
export function firstSessionPrompt(messages: readonly SessionMessageSnapshot[], sessionID: string): string | undefined {
  const first = ordered(messages).find((message) => message.info.role === "user" && message.info.sessionID === sessionID);
  if (!first) return undefined;
  const text = first.parts.filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text).join("\n");
  return visibleUserText(text) || undefined;
}
