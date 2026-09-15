import { posix, win32 } from "node:path";
import type { ActivityParser, ToolActivityContext } from "./activity-parser.ts";
import { toolParser } from "./activity-parser.ts";
import { inputText } from "./activity-format.ts";

/** Runtime paths only; summary parsing never reads the filesystem or changes the PRD. */
export type ActivityContext = { readonly repoDir: string; readonly prdDir?: string };
type Role = "tasks" | "notes" | "stories" | "plan" | "spec" | "reference";
type Access = { path: string; action: "read" | "write" | "delete"; cwd?: string };

function pathResolver(context: ActivityContext) {
  const paths = /^(?:[a-z]:[\\/]|\\\\)/i.test(context.repoDir) ? win32 : posix;
  const resolve = (path: string, cwd = context.repoDir) => paths.resolve(cwd, path);
  const prd = resolve(context.prdDir!);
  return { resolve, role(path: string, cwd?: string): Role | undefined {
    const relative = paths.relative(prd, resolve(path, cwd)).replaceAll("\\", "/");
    if (!relative || relative === ".." || relative.startsWith("../") || paths.isAbsolute(relative)) return;
    if (relative === "prd.json") return "tasks";
    if (relative === "progress.txt") return "notes";
    const name = relative.split("/").pop()!;
    if (/^(?:.*[-_])?(?:user[-_])?stor(?:y|ies)\.md$/i.test(name) || /^us-\d+[a-z0-9]*(?:[-_].*)?\.md$/i.test(name)) return "stories";
    if (/^(?:prd-.*-)?(?:\d+-)?index\.md$|^readme\.md$/i.test(name)) return "plan";
    if (/^(?:spec(?:ification)?(?:[-_].*)?|.*[-_]spec(?:ification)?)\.md$/i.test(name)) return "spec";
    return "reference";
  } };
}

const subjects: Record<Role, string> = {
  tasks: "the PRD task list", notes: "agent handoff notes", stories: "user stories and acceptance criteria",
  plan: "the PRD plan and dependencies", spec: "the PRD technical specification", reference: "PRD references and design notes",
};
function message(role: Role | undefined, action: Access["action"], phase: ToolActivityContext["phase"]): string {
  const subject = role ? subjects[role] : "the PRD and supporting material";
  if (phase === "failed") return action === "read" ? "Could not read " + subject : "Could not update " + subject;
  if (action === "delete") return (phase === "done" ? "Reviewing removal of " : "Removing ") + subject;
  if (action === "read") return "Reviewing " + subject;
  if (role === "notes") return phase === "done" ? "Reviewing progress and handoff updates" : "Recording progress, issues, and handoff notes";
  // A completed tool is an observation, never a claim that the story passed.
  const edited = role === "tasks" ? "PRD task list" : role === "stories" ? "user story" : role === "spec" ? "PRD specification" : role === "plan" ? "PRD plan" : "PRD supporting material";
  return phase === "done" ? "Reviewing " + edited + " changes" : "Updating " + subject;
}

/** Small literal shell lexer, not an evaluator. Opaque scripts and expansions stay generic. */
function shellChunks(command: string): string[][] {
  // The first heredoc body is data. Its command header still exposes redirects.
  const heredoc = command.match(/<<[^\n]*\n/);
  if (heredoc?.index !== undefined) command = command.slice(0, heredoc.index + heredoc[0].length - 1);
  const chunks: string[][] = [[]];
  let word = "", started = false, quote = "";
  const flush = () => { if (started) chunks.at(-1)!.push(word); word = ""; started = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && /["\\$`]/.test(command[i + 1] ?? "")) word += command[++i];
      else word += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === "\\") { if (command[i + 1] !== "\n") { word += command[i + 1] ?? ""; started = true; } i++; }
    else if (c === "#" && !started) { while (i < command.length && command[i] !== "\n") i++; flush(); chunks.push([]); }
    else if (";&|\n".includes(c)) { flush(); chunks.push([]); }
    else if (c === "<" || c === ">") {
      flush(); let operator = c;
      if (command[i + 1] === c) { operator += c; i++; }
      chunks.at(-1)!.push("\0" + operator);
    } else if (/\s/.test(c)) flush();
    else { word += c; started = true; }
  }
  if (quote) return [];
  flush();
  return chunks.filter(chunk => chunk.length);
}
const literalPath = (word: string) => word.length > 0 && !/[$`*?{}()\x00-\x1f]/.test(word) && !word.startsWith("~");

function shellAccesses(input: Record<string, unknown>, resolve: (path: string, cwd?: string) => string): Access[] {
  const command = inputText(input, "command", "cmd");
  if (/\$\(|`/.test(command)) return [];
  const workdir = inputText(input, "workdir", "cwd");
  if (workdir && !literalPath(workdir)) return [];
  let cwd = workdir ? resolve(workdir) : undefined;
  const accesses: Access[] = [];
  for (const chunk of shellChunks(command)) {
    let args = [...chunk];
    if (args[0] === "timeout" && /^\d+(?:[smh])?$/.test(args[1] ?? "")) args = args.slice(2);
    const executable = args.shift()?.split("/").pop();
    if (executable === "cd") {
      const directory = args.filter(arg => arg !== "--");
      if (directory.length !== 1 || !literalPath(directory[0]!) || directory[0] === "-") break;
      cwd = resolve(directory[0]!, cwd);
      continue;
    }
    // Only recognized file-oriented commands qualify. Never infer reads from a
    // path passed to tests, git, an interpreter, or printed as prose.
    if (!executable || !/^(?:cat|head|tail|less|more|sed|jq|rg|grep|tee|printf|echo|mv|cp)$/.test(executable)) return [];
    let redirected = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "\0>" || args[i] === "\0>>") {
        const path = args[i + 1];
        if (path && literalPath(path)) accesses.push({ path, action: "write", cwd });
        redirected = true;
      }
    }
    if (redirected) continue;
    if (executable === "printf" || executable === "echo") continue;
    if (executable === "mv" || executable === "cp") {
      const path = args.at(-1);
      if (path && !path.startsWith("-") && literalPath(path)) accesses.push({ path, action: "write", cwd });
      continue;
    }
    const writes = executable === "tee" || executable === "sed" && args.some(arg => /^-i|^--in-place(?:=|$)/.test(arg));
    const needsExpression = /^(?:sed|jq|rg|grep)$/.test(executable);
    let expressionSeen = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "\0<") { expressionSeen = true; continue; }
      if (arg === "\0<<") break;
      if (arg.startsWith("-")) {
        if (executable === "jq" && /^(?:--arg|--argjson|--slurpfile|--rawfile)$/.test(arg)) i += 2;
        else if (executable !== "jq" && /^(?:-e|--expression|-f|--file)$/.test(arg)) { expressionSeen = true; i++; }
        else if (/^(?:head|tail)$/.test(executable) && /^(?:-n|-c|--lines|--bytes)$/.test(arg)) i++;
        else if (/^(?:rg|grep)$/.test(executable) && /^(?:-A|-B|-C|-m|--max-count|-g|--glob|-t|--type)$/.test(arg)) i++;
        continue;
      }
      if (needsExpression && !expressionSeen) { expressionSeen = true; continue; }
      if (literalPath(arg)) accesses.push({ path: arg, action: writes ? "write" : "read", cwd });
    }
  }
  return accesses;
}

export function createPrdActivityParser(context: ActivityContext): ActivityParser {
  const paths = pathResolver(context);
  return toolParser("prd-files", ["read", "read_file", "edit", "write", "multiedit", "apply_patch", "bash", "shell", "exec_command", "terminal", "grep", "glob", "search"], ({ input, event, phase }) => {
    let accesses: Access[] = [];
    const tool = event.tool.toLowerCase();
    if (/^(?:bash|shell|exec_command|terminal)$/.test(tool)) accesses = shellAccesses(input, paths.resolve);
    else if (tool === "apply_patch") {
      const patch = input.patchText ?? input.patch ?? input.input;
      if (typeof patch !== "string") return;
      accesses = [...patch.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)\r?$/gm)].map(match => ({ path: match[2]!.trim(), action: match[1] === "Delete" ? "delete" : "write" }));
      accesses.push(...[...patch.matchAll(/^\*\*\* Move to: (.+)\r?$/gm)].map(match => ({ path: match[1]!.trim(), action: "write" as const })));
    } else {
      const path = inputText(input, "filePath", "file_path", "path");
      if (path) accesses.push({ path, action: /^(?:edit|write|multiedit)$/.test(tool) ? "write" : "read" });
      if (tool === "multiedit" && Array.isArray(input.edits)) {
        for (const edit of input.edits) {
          if (edit && typeof edit === "object") {
            const path = inputText(edit as Record<string, unknown>, "filePath", "file_path", "path");
            if (path) accesses.push({ path, action: "write" });
          }
        }
      }
    }
    if (!accesses.length) return;
    const roles = accesses.map(access => paths.role(access.path, access.cwd));
    // Mixed implementation/PRD operations retain the existing multi-file summary.
    if (roles.some(role => role === undefined)) return;
    const role = roles.every(role => role === roles[0]) ? roles[0] : undefined;
    const action = accesses.every(access => access.action === "delete") ? "delete" : accesses.some(access => access.action !== "read") ? "write" : "read";
    return message(role, action, phase);
  });
}
