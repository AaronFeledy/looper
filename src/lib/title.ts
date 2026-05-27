import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2";

import { createOpencodeID } from "./runner.ts";

const TITLE_MAX_CHARS = 100;

/**
 * Verbatim copy of opencode's title agent prompt (sst/opencode @
 * packages/opencode/src/agent/prompt/title.txt). Used as the system prompt for
 * a throwaway session so titles look like the ones opencode generates natively.
 *
 * Kept inline (rather than a text import) so this file is self-contained and
 * survives prompt drift in upstream opencode without runtime surprises.
 */
const TITLE_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"implement rate limiting" → Rate limiting implementation
"how do I connect postgres to my API" → Postgres API connection
"best practices for React hooks" → React hooks best practices
"@src/auth.ts can you add refresh token support" → Auth refresh token support
"@utils/parser.ts this is broken" → Parser bug fix
"look at @config.json" → Config review
"@App.tsx add dark mode toggle" → Dark mode toggle in App
</examples>`;

/**
 * Mirror opencode's title post-processing: strip <think> blocks, take the first
 * non-empty line, truncate to 100 chars.
 * See sst/opencode @ packages/opencode/src/session/prompt.ts:219-228.
 */
export function postprocessTitle(raw: string): string {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const lines = stripped.split("\n");
  let candidate = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      candidate = trimmed;
      break;
    }
  }
  if (candidate.length > TITLE_MAX_CHARS) candidate = candidate.slice(0, TITLE_MAX_CHARS);
  return candidate;
}

/**
 * Pull assistant text parts (skipping reasoning, tool calls, and synthetic /
 * ignored parts) and join them. Returns "" if the session has no usable
 * assistant output yet.
 */
export function extractAssistantText(entries: Array<{ info: Message; parts: Part[] }>): string {
  const chunks: string[] = [];
  for (const entry of entries) {
    if (entry.info.role !== "assistant") continue;
    for (const part of entry.parts) {
      if (part.type !== "text") continue;
      if (part.synthetic === true || part.ignored === true) continue;
      const text = part.text.trim();
      if (text.length > 0) chunks.push(text);
    }
  }
  return chunks.join("\n\n").trim();
}

/**
 * Best-effort title overwrite. Failures are logged via the optional `log`
 * callback but never thrown — title updates must not break the loop.
 */
export async function setSessionTitle({
  client,
  repoDir,
  sessionID,
  title,
  log,
}: {
  client: OpencodeClient;
  repoDir: string;
  sessionID: string;
  title: string;
  log?: (line: string) => void;
}): Promise<void> {
  try {
    const result = await client.session.update({ sessionID, directory: repoDir, title });
    if (result.error) log?.(`[looper] session.update failed for ${sessionID}: ${formatError(result.error)}`);
  } catch (error) {
    log?.(`[looper] session.update threw for ${sessionID}: ${formatError(error)}`);
  }
}

/**
 * Fire opencode's built-in title agent against `contextText` via a throwaway
 * session. Returns the post-processed title, or undefined on any failure
 * (caller falls back to letting opencode auto-title normally).
 *
 * We try `agent: "title"` first. If the server rejects that (e.g. hidden
 * agents are not exposed via the public prompt API), we retry without an agent
 * and supply the title prompt verbatim as the `system` override.
 */
export async function generateWorkDescription({
  client,
  repoDir,
  contextText,
  signal,
  log,
}: {
  client: OpencodeClient;
  repoDir: string;
  contextText: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<string | undefined> {
  const trimmed = contextText.trim();
  if (trimmed.length === 0) return undefined;
  if (signal?.aborted) return undefined;

  let titleSessionID: string | undefined;
  try {
    const created = await client.session.create({ directory: repoDir }, { signal });
    if (created.error || !created.data?.id) {
      log?.(`[looper] title gen: session.create failed: ${formatError(created.error)}`);
      return undefined;
    }
    titleSessionID = created.data.id;

    const result = await tryTitlePrompt({
      client,
      repoDir,
      sessionID: titleSessionID,
      contextText: trimmed,
      signal,
      log,
    });
    if (!result) return undefined;
    const titleText = extractAssistantText([{ info: result.info, parts: result.parts }]);
    if (titleText.length === 0) {
      log?.("[looper] title gen: assistant returned no text");
      return undefined;
    }
    const cleaned = postprocessTitle(titleText);
    return cleaned.length > 0 ? cleaned : undefined;
  } catch (error) {
    if (isAbort(error)) return undefined;
    log?.(`[looper] title gen threw: ${formatError(error)}`);
    return undefined;
  } finally {
    if (titleSessionID !== undefined) {
      void client.session
        .delete({ sessionID: titleSessionID, directory: repoDir })
        .catch(() => undefined);
    }
  }
}

async function tryTitlePrompt({
  client,
  repoDir,
  sessionID,
  contextText,
  signal,
  log,
}: {
  client: OpencodeClient;
  repoDir: string;
  sessionID: string;
  contextText: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<{ info: Message; parts: Part[] } | undefined> {
  // Attempt 1: built-in hidden agent (matches opencode's native title path).
  const firstResp = await client.session.prompt(
    {
      sessionID,
      directory: repoDir,
      messageID: createOpencodeID("msg"),
      parts: [{ type: "text", text: contextText }],
      agent: "title",
    },
    { signal },
  );
  if (!firstResp.error && firstResp.data) return firstResp.data;

  // Attempt 2: supply title prompt verbatim as system override, no agent.
  // Use a fresh messageID because some server errors may have partially recorded the first.
  log?.(`[looper] title gen: agent="title" failed (${formatError(firstResp.error)}); retrying with system prompt`);
  const secondResp = await client.session.prompt(
    {
      sessionID,
      directory: repoDir,
      messageID: createOpencodeID("msg"),
      parts: [{ type: "text", text: contextText }],
      system: TITLE_PROMPT,
    },
    { signal },
  );
  if (secondResp.error || !secondResp.data) {
    log?.(`[looper] title gen: fallback prompt failed: ${formatError(secondResp.error)}`);
    return undefined;
  }
  logFallbackUsage(secondResp.data.info, log);
  return secondResp.data;
}

/**
 * Fallback bypasses opencode's hidden `title` agent and uses the server's
 * default agent + model. Surface what was billed so users notice if it's a
 * heavyweight default. Wrapped in try/catch because this is purely
 * diagnostic — a malformed response must not throw past the caller and
 * discard the successfully generated title.
 */
function logFallbackUsage(info: Message, log: ((line: string) => void) | undefined): void {
  if (log === undefined) return;
  try {
    if (info.role !== "assistant") return;
    const cost = typeof info.cost === "number" ? `${info.cost.toFixed(4)}` : "n/a";
    log(`[looper] title gen: fallback used agent=${info.agent} model=${info.providerID}/${info.modelID} cost=${cost}`);
  } catch {}
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatError(error: unknown): string {
  if (error === undefined || error === null) return "unknown error";
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    return typeof message === "string" ? message : JSON.stringify(error);
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
