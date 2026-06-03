import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2";

import type { TitleGenConfig } from "./config.ts";
import { createOpencodeID } from "./runner.ts";
import { TITLE_AGENT_NAME } from "./title-agent.ts";

function parseTitleModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/**
 * Curated cheap/fast model name fragments, in opencode's own preference order
 * (sst/opencode @ packages/opencode/src/provider/provider.ts `getSmallModel`,
 * v1.15.13). Matched as substrings against a provider's available model ids.
 * Kept inline because opencode doesn't expose its resolved small model via the
 * config API — only the raw (often unset) `small_model` field.
 */
const PRIORITY_SMALL_MODELS = [
  "claude-haiku-4-5",
  "claude-haiku-4.5",
  "3-5-haiku",
  "3.5-haiku",
  "gemini-3-flash",
  "gemini-2.5-flash",
  "gpt-5-nano",
] as const;

type ResolvedModel = { providerID: string; modelID: string };

function modelTotalCost(model: { cost?: { input?: number; output?: number } }): number {
  return (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
}

/**
 * Pick a cheap title model the way opencode resolves its hidden title agent
 * when `small_model` is unset: scope to the provider that ran the step, prefer
 * opencode's curated cheap-model names, then fall back to the cheapest
 * non-reasoning model that provider offers. opencode's `getSmallModel`
 * heuristic isn't reachable via the public API, so this reproduces it from the
 * provider/model list (which exposes per-model `reasoning` + `cost`).
 *
 * Returns undefined (caller falls through to opencode's heavyweight default)
 * when the provider can't be determined, the list can't be read, or no
 * suitable model exists.
 */
async function resolveHeuristicTitleModel({
  client,
  repoDir,
  providerID,
  signal,
  log,
}: {
  client: OpencodeClient;
  repoDir: string;
  providerID: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<ResolvedModel | undefined> {
  try {
    const result = await client.provider.list({ directory: repoDir }, { signal });
    if (result.error || !result.data) {
      log?.(`[looper] title gen: provider.list failed: ${formatError(result.error)}`);
      return undefined;
    }
    const provider = result.data.all.find((p) => p.id === providerID);
    if (!provider) return undefined;
    const models = Object.values(provider.models).filter((m) => m.status !== "deprecated");
    // Filter to non-reasoning models BEFORE the priority match, not after.
    // opencode auto-applies its adaptive-thinking variant to any
    // reasoning-capable model, and cheap reasoning models (e.g.
    // claude-haiku-4-5) reject it with a 400 ("adaptive thinking is not
    // supported on this model") reported inside the assistant message's
    // `error` field — which previously surfaced as an empty "no text" title.
    const nonReasoning = models.filter((m) => m.capabilities.reasoning === false);
    if (nonReasoning.length === 0) return undefined;
    for (const fragment of PRIORITY_SMALL_MODELS) {
      const match = nonReasoning.find((m) => m.id.includes(fragment));
      if (match) return { providerID: provider.id, modelID: match.id };
    }
    const cheapest = nonReasoning.reduce((a, b) => (modelTotalCost(a) <= modelTotalCost(b) ? a : b));
    return { providerID: provider.id, modelID: cheapest.id };
  } catch (error) {
    if (isAbort(error)) return undefined;
    log?.(`[looper] title gen: provider.list threw: ${formatError(error)}`);
    return undefined;
  }
}

/**
 * Resolve the default title model when neither `opencode.title.model` nor a
 * caller override applies. Mirrors opencode's title-agent model resolution
 * (v1.15.13): opencode's configured `small_model` first, then a cheap-model
 * heuristic scoped to the provider that ran the step. Looper rolls its own
 * title session (opencode's hidden title agent rejects the public prompt API),
 * so without this the throwaway session inherits opencode's heavyweight
 * default `model`.
 *
 * Best-effort: returns undefined (caller falls through to opencode's default)
 * if nothing suitable can be resolved.
 */
async function resolveDefaultTitleModel({
  client,
  repoDir,
  providerID,
  signal,
  log,
}: {
  client: OpencodeClient;
  repoDir: string;
  providerID?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<ResolvedModel | undefined> {
  try {
    const result = await client.config.get({ directory: repoDir }, { signal });
    if (!result.error && result.data) {
      const configured = parseTitleModel(result.data.small_model);
      if (configured) return configured;
    } else {
      log?.(`[looper] title gen: config.get failed: ${formatError(result.error)}`);
    }
  } catch (error) {
    if (isAbort(error)) return undefined;
    log?.(`[looper] title gen: config.get threw: ${formatError(error)}`);
  }
  if (providerID === undefined || providerID.length === 0) return undefined;
  return resolveHeuristicTitleModel({ client, repoDir, providerID, signal, log });
}

/**
 * Provider/model of the most recent assistant message — i.e. the model that
 * actually ran the step. Used to scope the cheap-title-model heuristic to the
 * same provider, matching how opencode's title agent uses the step's provider.
 */
export function extractAssistantModel(
  entries: Array<{ info: Message; parts: Part[] }>,
): ResolvedModel | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const info = entries[i]?.info;
    if (info?.role !== "assistant") continue;
    const providerID = info.providerID;
    const modelID = info.modelID;
    if (typeof providerID === "string" && providerID.length > 0 && typeof modelID === "string" && modelID.length > 0) {
      return { providerID, modelID };
    }
  }
  return undefined;
}

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
 * throwaway session. opencode's own title agent isn't exposed by the public
 * `session.prompt` API, so we run our own session against the `looper-title`
 * agent (a hidden subagent materialized by title-agent.ts whose only job is to
 * be a clean, variant-free param baseline — see TITLE_AGENT_NAME). The actual
 * title instructions are passed as a `system` override (TITLE_PROMPT, a
 * looper-customized derivative of opencode's title prompt) and the model is
 * chosen per-provider by the cheap-model heuristic. Naming the agent is what
 * stops opencode from inheriting the default agent's adaptive-thinking variant,
 * which reasoning-capable cheap models reject with a 400. An explicit
 * `opencode.title.agent` in looper.yaml overrides the default.
 *
 * Returns the post-processed title, or undefined on any failure (caller falls
 * back to letting opencode auto-title normally).
 */
export async function generateWorkDescription({
  client,
  repoDir,
  contextText,
  branchHint,
  config,
  sessionProviderID,
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
  /**
   * Optional agent/model/variant overrides from `opencode.title:` in
   * looper.yaml. Each field is forwarded independently; unspecified fields
   * fall through to opencode's defaults.
   */
  config?: TitleGenConfig;
  /**
   * Provider that ran the step (from the step session's assistant messages).
   * Scopes the cheap-title-model heuristic to the same provider when no
   * explicit title model is configured.
   */
  sessionProviderID?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<string | undefined> {
  const trimmed = contextText.trim();
  if (trimmed.length === 0 && (branchHint === undefined || branchHint.length === 0)) return undefined;
  if (signal?.aborted) return undefined;
  const branchLine = branchHint && branchHint.length > 0 ? `[branch: ${branchHint}]\n\n` : "";
  const userMessage = `${branchLine}${trimmed}`;
  const titleAgent = config?.agent ?? TITLE_AGENT_NAME;
  const titleVariant = config?.variant;
  const titleModel =
    parseTitleModel(config?.model) ??
    (await resolveDefaultTitleModel({
      client,
      repoDir,
      ...(sessionProviderID !== undefined ? { providerID: sessionProviderID } : {}),
      signal,
      log,
    }));

  let titleSessionID: string | undefined;
  let preserveSession = false;
  try {
    const created = await client.session.create(
      { directory: repoDir, ...(titleAgent ? { agent: titleAgent } : {}) },
      { signal },
    );
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
        ...(titleAgent ? { agent: titleAgent } : {}),
        ...(titleModel ? { model: titleModel } : {}),
        ...(titleVariant ? { variant: titleVariant } : {}),
      },
      { signal },
    );
    if (resp.error || !resp.data) {
      log?.(`[looper] title gen: prompt failed: ${formatError(resp.error)}`);
      preserveSession = true;
      return undefined;
    }
    logTitleAgentUsage(resp.data.info, log);

    const modelError = extractMessageError(resp.data.info);
    if (modelError !== undefined) {
      log?.(`[looper] title gen: model returned an error: ${modelError}`);
      preserveSession = true;
      return undefined;
    }

    const titleText = extractAssistantText([{ info: resp.data.info, parts: resp.data.parts }]);
    if (titleText.length === 0) {
      log?.("[looper] title gen: assistant returned no text");
      preserveSession = true;
      return undefined;
    }
    const cleaned = postprocessTitle(titleText);
    if (cleaned.length === 0) {
      log?.("[looper] title gen: title empty after postprocessing");
      preserveSession = true;
      return undefined;
    }
    return cleaned;
  } catch (error) {
    if (isAbort(error)) return undefined;
    log?.(`[looper] title gen threw: ${formatError(error)}`);
    preserveSession = titleSessionID !== undefined;
    return undefined;
  } finally {
    if (titleSessionID !== undefined) {
      if (preserveSession) {
        log?.(`[looper] title gen: kept failed title session ${titleSessionID} for review`);
      } else {
        // Success or cancellation. The throwaway title session keeps generating
        // server-side even after our client request returns/aborts, so abort it
        // first, then delete it. Both are awaited and their failures logged so a
        // silently-failed delete can no longer leak a session whose first
        // message is a copy of the step's assistant output.
        try {
          await client.session.abort({ sessionID: titleSessionID, directory: repoDir });
        } catch (error) {
          log?.(`[looper] title gen: session.abort threw for ${titleSessionID}: ${formatError(error)}`);
        }
        try {
          const deleted = await client.session.delete({ sessionID: titleSessionID, directory: repoDir });
          if (deleted?.error) {
            log?.(`[looper] title gen: session.delete failed for ${titleSessionID}: ${formatError(deleted.error)}`);
          }
        } catch (error) {
          log?.(`[looper] title gen: session.delete threw for ${titleSessionID}: ${formatError(error)}`);
        }
      }
    }
  }
}

/**
 * Log which agent + model + variant actually ran the title prompt so a
 * mis-configured `opencode.title:` (or a missing override that fell through
 * to a heavyweight default) is visible without enabling debug events. Wrapped
 * in try/catch because this is purely diagnostic — a malformed response must
 * not throw past the caller and discard the successfully generated title.
 */
function logTitleAgentUsage(info: Message, log: ((line: string) => void) | undefined): void {
  if (log === undefined) return;
  try {
    if (info.role !== "assistant") return;
    const cost = typeof info.cost === "number" ? `${info.cost.toFixed(4)}` : "n/a";
    log(`[looper] title gen used agent=${info.agent} model=${info.providerID}/${info.modelID} cost=${cost}`);
  } catch {}
}

/**
 * opencode reports provider/model failures (auth, context overflow, and 400s
 * such as "adaptive thinking is not supported on this model") in the assistant
 * message's `error` field rather than the transport-level response error.
 * Surfacing it here is what stops those failures from masquerading as an empty
 * "assistant returned no text" result. Returns a short "Name (status) message"
 * summary, or undefined when the message carries no error.
 */
function extractMessageError(info: Message): string | undefined {
  if (info.role !== "assistant") return undefined;
  const error = (info as { error?: unknown }).error;
  if (error === undefined || error === null || typeof error !== "object") return undefined;
  const name = typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "error";
  const data = (error as { data?: unknown }).data;
  let message = "";
  let statusCode: number | undefined;
  if (data !== null && typeof data === "object") {
    const rawMessage = (data as { message?: unknown }).message;
    if (typeof rawMessage === "string") message = rawMessage;
    const rawStatus = (data as { statusCode?: unknown }).statusCode;
    if (typeof rawStatus === "number") statusCode = rawStatus;
  }
  const summary = [name, statusCode !== undefined ? `(${statusCode})` : "", message].filter((p) => p.length > 0).join(" ");
  return summary.length > 0 ? summary : JSON.stringify(error);
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
