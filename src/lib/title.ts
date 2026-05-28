import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2";

import { createOpencodeID } from "./runner.ts";

const TITLE_MAX_CHARS = 100;

/**
 * System prompt for the throwaway title session. Originally a verbatim copy of
 * opencode's title agent prompt (sst/opencode @
 * packages/opencode/src/agent/prompt/title.txt) but customized for looper's
 * input shape: we feed the assistant's *work log* from a build/review step,
 * not a user chat message, so the prompt is framed accordingly and adds
 * explicit rules for ignoring mode banners, role declarations, and other
 * boilerplate the agent emits before getting to actual work.
 *
 * Kept inline so this file is self-contained and survives drift in upstream
 * opencode without runtime surprises.
 */
const TITLE_PROMPT = `You are a title generator for an autonomous coding agent's work log. You output ONLY a thread title. Nothing else.

<task>
The input is the assistant's narration of work it performed in one step of an automated coding loop (file edits, code changes, decisions, debugging, test runs). Produce a short title that captures WHAT THE AGENT IS WORKING ON.

Follow all rules in <rules>.
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- Title must be grammatically correct and read naturally - no word salad.
- Focus on the concrete subject of the work: the feature, bug, file, story ID, system, or refactor being executed.
- IGNORE mode banners, role declarations, agent identity statements, status preambles, and meta narration. Examples that must NEVER become titles: "ULTRAWORKER MODE", "ULTRAWORK MODE", "ULTRATHINK", "Starting work", "I'll handle this", "Plan:", "TL;DR:", "Continuing where I left off", any single-line ALL-CAPS banner, any sentence whose only content is the agent's mode, identity, or current state.
- If the log opens with such a banner, skip past it and title from the actual work that follows.
- If the input begins with a "[branch: <name>]" hint, treat that branch name as a STRONG candidate for the title (humanized into Title Case prose if needed). Branches are chosen by the agent specifically to summarize the work in progress, so they're a reliable signal unless the work log clearly describes something different.
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool", "grep").
- Vary your phrasing - avoid repetitive openings like always starting with "Working on", "Implementing", "Analyzing".
- When a file or symbol is mentioned, focus on what is being DONE to it.
- Keep exact: technical terms, numbers, filenames, HTTP codes, branch names, story IDs (e.g. US-001, US-057).
- Remove filler: the, this, my, a, an.
- Never assume tech stack beyond what the log mentions.
- Never use tools.
- NEVER include "summarizing" or "generating" in the title.
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT.
- Always output something meaningful. If the log is dominated by boilerplate with little real work yet, title from whatever real work IS present (e.g. the file being read, the branch being checked out, the story ID just selected).
</rules>

<examples>
"ULTRAWORKER MODE\n\nReading spec/beta/prd.json to pick the next story. Selected US-057, checking out us-057-guide-frontmatter-schema..." → US-057 guide frontmatter schema
"ULTRAWORK MODE\n\nFixed the 500 error in /api/users — the JWT middleware was throwing on null session cookies. Added a guard and a test." → 500 error fix in JWT middleware
"Plan: refactor the user service to extract billing logic into its own module." → User service billing extraction
"TL;DR: bumped @opencode-ai/sdk to v2.3.1 and adjusted the new prompt() signature across runner.ts and title.ts." → opencode-ai/sdk v2.3.1 bump
"I'll handle the dark mode toggle. Added a theme context provider to App.tsx and wired the toggle into the header." → Dark mode toggle in App
"Continuing where I left off. The migration script needs IF NOT EXISTS guards on every CREATE TABLE." → Migration IF NOT EXISTS guards
"Investigating why pg connection times out. Pool config was missing max=10, fixed." → Postgres pool max fix
"ULTRATHINK\n\nRan bun typecheck and bun test — both green. Committed feat: US-001 provider-lando Linux setup." → US-001 provider-lando Linux setup
"[branch: us-057-guide-frontmatter-schema]\n\nULTRAWORKER MODE\n\nReading spec/beta/prd.json to decide which story to pick up." → US-057 guide frontmatter schema
"[branch: fix-pg-pool-timeout]\n\nPlan: bump max=10 and add a backoff." → Fix pg pool timeout
</examples>`

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
 * Approximate opencode's hidden title agent against `contextText` via a
 * throwaway session. The title agent isn't exposed by opencode's public
 * `session.prompt` API, so we pass TITLE_PROMPT (a looper-customized
 * derivative of opencode's title prompt) as a `system` override against the
 * server's default agent + model.
 *
 * Returns the post-processed title, or undefined on any failure (caller falls
 * back to letting opencode auto-title normally).
 */
export async function generateWorkDescription({
  client,
  repoDir,
  contextText,
  branchHint,
  signal,
  log,
}: {
  client: OpencodeClient;
  repoDir: string;
  contextText: string;
  /**
   * Optional current git branch. Surfaced to the title prompt as a labelled
   * hint and treated as a strong title candidate. Callers should strip
   * uninformative defaults (main/master/dev/develop/trunk) before passing it
   * in.
   */
  branchHint?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<string | undefined> {
  const trimmed = contextText.trim();
  if (trimmed.length === 0 && (branchHint === undefined || branchHint.length === 0)) return undefined;
  if (signal?.aborted) return undefined;
  const branchLine = branchHint && branchHint.length > 0 ? `[branch: ${branchHint}]\n\n` : "";
  const userMessage = `${branchLine}${trimmed}`;

  let titleSessionID: string | undefined;
  try {
    const created = await client.session.create({ directory: repoDir }, { signal });
    if (created.error || !created.data?.id) {
      log?.(`[looper] title gen: session.create failed: ${formatError(created.error)}`);
      return undefined;
    }
    titleSessionID = created.data.id;

    const resp = await client.session.prompt(
      {
        sessionID: titleSessionID,
        directory: repoDir,
        messageID: createOpencodeID("msg"),
        parts: [{ type: "text", text: userMessage }],
        system: TITLE_PROMPT,
      },
      { signal },
    );
    if (resp.error || !resp.data) {
      log?.(`[looper] title gen: prompt failed: ${formatError(resp.error)}`);
      return undefined;
    }
    logTitleAgentUsage(resp.data.info, log);

    const titleText = extractAssistantText([{ info: resp.data.info, parts: resp.data.parts }]);
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

/**
 * Title generation runs against whatever default agent + model the opencode
 * server is configured with. Surface that so users notice if it's a
 * heavyweight default. Wrapped in try/catch because this is purely
 * diagnostic — a malformed response must not throw past the caller and
 * discard the successfully generated title.
 */
function logTitleAgentUsage(info: Message, log: ((line: string) => void) | undefined): void {
  if (log === undefined) return;
  try {
    if (info.role !== "assistant") return;
    const cost = typeof info.cost === "number" ? `${info.cost.toFixed(4)}` : "n/a";
    log(`[looper] title gen used agent=${info.agent} model=${info.providerID}/${info.modelID} cost=${cost}`);
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
