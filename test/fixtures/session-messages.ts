import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2";
import type { SessionMessageSnapshot } from "../../src/lib/session-inspection.ts";

export function userMessage(sessionID: string, overrides: Partial<UserMessage> = {}, text = "Build the activity bubbles."): SessionMessageSnapshot {
  const info: UserMessage = {
    id: "msg_user", sessionID, role: "user", time: { created: 1 }, agent: "build",
    model: { providerID: "openai", modelID: "requested-model", variant: "high" }, ...overrides,
  };
  return { info, parts: [{ type: "text", id: "prt_prompt", sessionID, messageID: info.id, text }] };
}

export function assistantMessage(sessionID: string, overrides: Partial<AssistantMessage> = {}, text = "The unit tests passed."): SessionMessageSnapshot {
  const info: AssistantMessage = {
    id: "msg_assistant", sessionID, role: "assistant", time: { created: 2 }, parentID: "msg_user",
    providerID: "openai", modelID: "reported-model", variant: "low", agent: "build", mode: "build",
    path: { cwd: "/repo", root: "/repo" }, cost: 0.0123,
    tokens: { input: 240, output: 80, reasoning: 25, cache: { read: 120, write: 10 } }, ...overrides,
  };
  return { info, parts: [{ type: "text", id: "prt_answer", sessionID, messageID: info.id, text }] };
}
