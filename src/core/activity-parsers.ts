import type { ActivityParser, ToolActivityContext } from "./activity-parser.ts";
import { createPrdActivityParser, type ActivityContext } from "./prd-activity.ts";
import { toolParser } from "./activity-parser.ts";
import { basename, inputText } from "./activity-format.ts";

const fileOf = (input: Record<string, unknown>) => basename(inputText(input, "filePath", "file_path", "path"));
const wording = (phase: ToolActivityContext["phase"], running: string, done: string) => phase === "done" ? done : running;

/** Only command positions count. Quoted prose, scripts and heredoc bodies aren't commands. */
function commandSummary(command: string, done: boolean): string | undefined {
  const executable = command.split(/<<[^\n]*\n/)[0]!.replace(/'(?:[^']*)'|"(?:\\.|[^"\\])*"/g, '""');
  const chunks = executable.split(/&&|\|\||[;|\n]/).map((s) =>
    s.trim().replace(/^timeout\s+\d+(?:[smh])?\s+/, ""));
  for (const cmd of chunks) {
    let match = cmd.match(/^gh\s+pr\s+(checks|view|create|merge|list)\b(?:\s+(\d+))?/);
    if (match) {
      const pr = match[2] ? "PR " + match[2] : "the pull request";
      switch (match[1]) {
        case "checks": return done ? "Reviewing CI for " + pr : cmd.includes("--watch") ? "Watching CI for " + pr : "Checking CI for " + pr;
        case "view": case "list": return "Inspecting " + pr;
        case "create": return done ? "Reviewing the pull request" : "Opening a pull request";
        case "merge": return done ? "Reviewing merge results" : "Merging " + pr;
      }
    }
    if (/^gh\s+api\b.*\/(?:pulls|issues)\/.*(?:comments|reviews)/.test(cmd)) return "Reading PR review comments";
    match = cmd.match(/^looper\s+signal\s+(story-phase\s+(\w+)|adjudicate|stop(?:-after-iteration)?)\b/);
    if (match) return match[2] ? "Recording story phase: " + match[2] : "Updating loop control";
    if (/^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test(?::[\w-]+)?|typecheck|lint|build)\b|^(?:vitest|jest|pytest|tsc|eslint|biome)\b/.test(cmd)) {
      if (/\b(?:test:unit|vitest|jest)\b/.test(cmd)) return done ? "Reviewing unit test results" : "Running unit tests";
      if (/\b(?:typecheck|tsc)\b/.test(cmd)) return done ? "Reviewing type diagnostics" : "Checking types";
      if (/\b(?:lint|eslint|biome)\b/.test(cmd)) return done ? "Reviewing style diagnostics" : "Checking code style";
      if (/\bbuild\b/.test(cmd)) return done ? "Reviewing build results" : "Building the project";
      const target = cmd.match(/(?:^|\s)([^\s"'<>]+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s|$)/)?.[1];
      return target ? (done ? "Reviewing " : "Testing ") + basename(target) : done ? "Reviewing test results" : "Running tests";
    }
  }
  return undefined;
}

const toolRules: ActivityParser[] = [
  toolParser("background-output", ["background_output"], ({ input, phase, event }) => {
    if (event.kind === "tool.done") {
      const header = event.output.slice(0, 600).split("\n---")[0]!;
      const description = /^Task Result\r?\n/.test(header) ? header.match(/^Description: (.+)$/m)?.[1] : undefined;
      if (description) return "Reviewing: " + description;
    }
    return wording(phase, input.block === true ? "Waiting for delegated results" : "Checking delegated progress", "Reviewing delegated results");
  }),
  toolParser("background-cancel", ["background_cancel"], ({ input }) =>
    input.all === true ? "Stopping remaining background agents" : "Stopping a background agent"),
  toolParser("task-plan", ["task_create", "task_update", "todowrite", "todoread"], ({ input, event }) => {
    // OMO task_update often supplies only an ID/status; the JSON reply carries
    // the current activeForm. Read only known fields, never arbitrary output prose.
    if (event.kind === "tool.done" && event.output.length < 16_000) {
      try {
        const result: unknown = JSON.parse(event.output);
        if (result && typeof result === "object") {
          if ("error" in result) return result.error === "task_lock_unavailable" ? "Task plan is locked" : "Task plan update needs attention";
          if ("task" in result && result.task && typeof result.task === "object" && !Array.isArray(result.task)) {
            input = { ...result.task, ...input };
          }
        }
      } catch { /* Older tools may return plain text. */ }
    }
    const active = inputText(input, "activeForm");
    if (input.status === "in_progress" && active) return active;
    if (input.status === "completed") return "Updating completed plan items";
    const todos = input.todos;
    if (Array.isArray(todos)) {
      const current = todos.find((item) => item && typeof item === "object" && item.status === "in_progress");
      if (current && typeof current.content === "string") return current.content;
    }
    const subject = inputText(input, "subject");
    return subject ? "Planning: " + subject : ["Updating the work plan", "Organizing the next steps", "Tracking work in progress"];
  }),
  toolParser("delegation", ["task", "call_omo_agent", "delegate", "agent"], ({ input, phase }) => {
    const description = inputText(input, "description");
    return description ? (phase === "done" ? input.run_in_background === true ? "Delegated: " : "Reviewing: " : "Delegating: ") + description
      : ["Delegating work", "Sharing work with an agent", "Assigning the next task"];
  }),
  toolParser("skill", ["skill"], ({ input, phase }) => {
    const name = inputText(input, "name");
    return name ? (phase === "done" ? "Reviewing " : "Loading ") + name + " guidance" : "Loading task guidance";
  }),
  toolParser("diagnostics", ["lsp_diagnostics"], ({ input, phase, event }) => {
    const file = fileOf(input);
    if (event.kind === "tool.done" && event.output.trim() === "No diagnostics found") return file ? "No diagnostics: " + file : "No diagnostics reported";
    return (phase === "done" ? "Reviewing" : "Checking") + " diagnostics" + (file ? ": " + file : "");
  }),
  toolParser("symbols", ["lsp_symbols", "lsp_find_references", "lsp_goto_definition"], ({ input }) =>
    "Locating " + (inputText(input, "query", "symbol") || fileOf(input) || "code symbols")),
  toolParser("codegraph", /(?:^|_)codegraph_explore$/, ({ input }) => {
    const query = inputText(input, "query").trim();
    const paths = query.split(/\s+/);
    if (paths.length > 1 && paths.every((s) => /\.[a-z]+$/i.test(s))) return "Mapping relationships across " + paths.length + " files";
    return query ? "Mapping " + basename(query) : "Mapping code relationships";
  }),
  toolParser("patch", ["apply_patch"], ({ input, phase }) => {
    const rawPatch = input.patchText ?? input.patch ?? input.input;
    const patch = typeof rawPatch === "string" ? rawPatch : "";
    const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]!);
    if (files.length > 1) return (phase === "done" ? "Reviewing edits across " : "Patching ") + files.length + " files";
    return files[0] ? (phase === "done" ? "Reviewing edits to " : "Editing ") + basename(files[0]) : "Applying code changes";
  }),
  toolParser("file-edit", ["edit", "write", "multiedit"], ({ input, phase }) => {
    const file = fileOf(input);
    return file ? (phase === "done" ? "Reviewing edits to " : "Editing ") + file
      : ["Writing code", "Making implementation changes", "Updating the implementation"];
  }),
  toolParser("file-read", ["read", "read_file"], ({ input, phase }) => {
    const file = fileOf(input);
    return file ? (phase === "done" ? "Reviewing " : "Reading ") + file : ["Reading source files", "Exploring the implementation", "Gathering code context"];
  }),
  toolParser("github-search", /searchgithub$/, ({ input }) => "Searching GitHub: " + (inputText(input, "query") || "code examples")),
  toolParser("web-search", /(?:websearch|google_search|web_search)/, ({ input }) => "Researching " + (inputText(input, "query") || "documentation")),
  toolParser("code-search", ["grep", "glob", "search"], ({ input, phase }) => {
    const query = inputText(input, "pattern", "query");
    // Dense regexes aren't useful as tiny labels.
    return query && /^[\w./ -]{1,65}$/.test(query)
      ? (phase === "done" ? "Reviewing matches for " : "Finding ") + query
      : fileOf(input) ? "Searching within " + fileOf(input) : ["Searching for context", "Locating relevant code", "Following code references"];
  }),
  toolParser("web-read", /^(?:webfetch|web_fetch|fetch|browse)$/, ({ input }) => {
    try { return "Reading " + new URL(inputText(input, "url")).hostname; } catch { return "Reading documentation"; }
  }),
  toolParser("shell", ["bash", "shell", "exec_command", "terminal"], ({ input, phase }) => {
    const command = inputText(input, "command", "cmd");
    const specific = commandSummary(command, phase === "done");
    if (specific) return specific;
    const description = inputText(input, "description");
    if (description) return description;
    const code = command.replace(/'(?:[^']*)'|"(?:\\.|[^"\\])*"/g, '""');
    if (/(?:^|&&|[;\n])\s*git\s+(?:diff|status|show|log)\b/.test(code)) return "Inspecting changes";
    if (/(?:^|&&|[;\n])\s*git\s+commit\b/.test(code)) return phase === "done" ? "Reviewing commit results" : "Committing changes";
    if (/(?:^|&&|[;\n])\s*git\s+push\b/.test(code)) return phase === "done" ? "Reviewing push results" : "Pushing branch changes";
    if (/(?:^|&&|[;\n])\s*(?:rg|grep|find)\b/.test(code)) return "Searching the codebase";
    return phase === "done" ? ["Reviewing tool results", "Inspecting command results", "Checking the command response"]
      : ["Running a command", "Working in the terminal", "Executing the next command"];
  }),
];

export const defaultActivityParsers: readonly ActivityParser[] = [
  { id: "bookkeeping", parse(event) {
    if (event.kind === "step.done" || event.kind.startsWith("user.") || event.kind.startsWith("looper.") ||
      event.kind === "debug.event" || event.kind === "continuation.notice") return null;
  } },
  { id: "failure", parse(event) {
    if (event.kind === "tool.failed") {
      const file = fileOf(event.input ?? {});
      if (/^(?:edit|write|apply_patch)$/.test(event.tool)) return file ? "Handling an edit failure: " + file : "Handling an edit failure";
      return "Handling " + event.tool.replaceAll("_", " ") + " failure";
    }
    if (["assistant.error", "session.error", "step.failed"].includes(event.kind)) return "Needs attention";
    if (event.kind === "assistant.aborted") return "Interrupted";
    if (event.kind === "retry") return ["Reconnecting", "Restoring the connection", "Retrying the connection"];
  } },
  ...toolRules,
  { id: "assistant-action", parse(event) {
    if (event.kind !== "assistant.text") return;
    const text = event.text.trim().replace(/^(?:Now\s+|Next,?\s+)/i, "");
    const action = text.match(/^(?:I(?:'m| am)\s+)?((?:running|writing|editing|checking|reading|reviewing|testing|building|fixing|implementing|searching|gathering|waiting|mapping|verifying|pulling|exploring|inspecting|examining)\b[^\n!?]*)/i)?.[1];
    if (action) return action.replace(/\.\s.*$|\.$/, "");
    const announced = text.match(/^(?:I(?:'ll| will)|Let me)\s+(read|check|review|test|build|fix|search|gather|inspect|verify|update|write|explore)\b([^\n!?]*)/i);
    if (announced) {
      const verbs: Record<string, string> = { read: "Reading", check: "Checking", review: "Reviewing", test: "Testing", build: "Building", fix: "Fixing", search: "Searching", gather: "Gathering", inspect: "Inspecting", verify: "Verifying", update: "Updating", write: "Writing", explore: "Exploring" };
      return (verbs[announced[1]!.toLowerCase()]! + announced[2]).replace(/\.\s.*$|\.$/, "");
    }
    return ["Preparing a response", "Putting findings into words", "Composing an update"];
  } },
  { id: "reasoning-label", parse(event) {
    if (event.kind !== "reasoning.text") return;
    // Only a complete, short emphasis label qualifies; never extract a heading
    // from a larger reasoning message. Match the existing summary size budget.
    const label = event.text.trim().match(/^(\*{1,2})([^*\r\n]+)\1$/)?.[2]?.trim();
    if (label && label.length <= 100 && label.split(/\s+/).length <= 7) return label;
  } },
  { id: "step-start", parse(event) {
    if (event.kind === "step.started") return ["Starting work", "Getting started", "Picking up the task"];
  } },
  { id: "fallback", parse(event) {
    switch (event.kind) {
      case "reasoning.started": case "reasoning.text": return ["Thinking through the next move", "Considering the next approach", "Working through the details"];
      case "assistant.started": return ["Planning the next move", "Choosing the next action", "Preparing the next step"];
      case "tool.started": return "Using " + event.tool.replaceAll("_", " ");
      case "tool.done": return ["Reviewing tool results", "Examining the latest results", "Checking the tool response"];
    }
  } },
];

const contextualParsers = new WeakMap<ActivityContext, readonly ActivityParser[]>();
export function activityParsersFor(context?: ActivityContext): readonly ActivityParser[] {
  if (!context?.prdDir) return defaultActivityParsers;
  let parsers = contextualParsers.get(context);
  if (!parsers) {
    parsers = [createPrdActivityParser(context), ...defaultActivityParsers];
    contextualParsers.set(context, parsers);
  }
  return parsers;
}
