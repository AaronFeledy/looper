import type { LooperEvent } from "../core/events.ts";

const ui = {
  dim: (text: string) => color("2", text),
  cyan: (text: string) => color("36", text),
  green: (text: string) => color("32", text),
  yellow: (text: string) => color("33", text),
  red: (text: string) => color("31", text),
  magenta: (text: string) => color("35", text),
  bold: (text: string) => color("1", text),
};

function color(code: string, text: string): string {
  if (process.env.NO_COLOR || (!process.stdout.isTTY && !process.stderr.isTTY)) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

function sectionTimestamp(at: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(at))
    .toLowerCase();
}

function terminalWidth(): number {
  return Math.max(40, process.stdout.columns ?? 80);
}

function groupHeader(title: string, accent: (text: string) => string, at?: number): string {
  const prefix = `╭─ ${title}`;
  const timestamp = sectionTimestamp(at);
  const gap = " ".repeat(Math.max(1, terminalWidth() - prefix.length - timestamp.length));
  return `${accent(prefix)}${gap}${ui.dim(timestamp)}`;
}

function groupLine(text: string): string {
  return `${ui.dim("│")} ${text}`;
}

function formatInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return json.length <= 200 ? json : `${json.slice(0, 200)}…`;
}

function toolOutputLines(output: string): string[] {
  const lines = output
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
  return lines.length === 0 ? [groupLine(ui.dim("(no output)"))] : lines.map((line) => groupLine(line));
}

function assertNever(value: never): never {
  throw new Error(`Unexpected LooperEvent: ${JSON.stringify(value)}`);
}

export function formatLooperEvent(event: LooperEvent, at?: number): string[] {
  switch (event.kind) {
    case "step.started":
      return [groupHeader("OpenCode step", ui.cyan, at)];
    case "step.done":
      return [
        `${ui.green("✓ step done")} ${ui.dim("reason=")}${event.reason} ${ui.dim("cost=")}$${event.cost.toFixed(4)} ${ui.dim("tokens=")}in ${event.tokens.input} / out ${event.tokens.output} / think ${event.tokens.reasoning} ${ui.dim("cache=")}r ${event.tokens.cacheRead} / w ${event.tokens.cacheWrite}`,
      ];
    case "step.failed":
      return [`[error] ${event.message}`];
    case "assistant.started":
      return [groupHeader("Assistant", ui.cyan, at)];
    case "assistant.text":
      return [event.text];
    case "assistant.error":
      return [`${ui.red("✗ assistant error")} ${event.message}`];
    case "assistant.aborted":
      return [ui.dim(`(aborted) ${event.message}`)];
    case "reasoning.started":
      return [groupHeader("Reasoning", ui.magenta, at)];
    case "reasoning.text":
      return [`${ui.dim("│")} ${event.text}`];
    case "tool.started":
      return [`${ui.yellow("◌ tool")} ${ui.bold(event.tool)} ${ui.dim(formatInput(event.input))}`];
    case "tool.done": {
      const lines = [groupHeader(`Tool output · ${event.tool}`, ui.green, at), ...toolOutputLines(event.output)];
      if (event.retainedOutputPath !== undefined) lines.push(groupLine(`${ui.dim("retained full output:")} ${event.retainedOutputPath}`));
      return lines;
    }
    case "tool.failed":
      return [`${ui.red("✗ tool failed")} ${ui.bold(event.tool)} ${event.error}`];
    case "session.error":
      return [`${ui.red("✗ session error")} ${event.message}`];
    case "retry":
      return [`${ui.yellow(`↻ retry ${event.attempt}`)} ${event.message}`];
    case "debug.event":
      return [`[debug] event=${event.eventType} sid=${event.sessionID ?? "-"}`];
    case "looper.log":
      return [`[looper] ${event.message}`];
    case "looper.error":
      return [`[error] ${event.message}`];
    case "continuation.notice": {
      const reason = event.reason !== undefined && event.reason.length > 0 ? ` reason=${event.reason}` : "";
      return [`[looper] ${event.prefix}: session=${event.sessionID} state=${event.state}${reason} updatedAt=${event.updatedAt}`];
    }
    default:
      return assertNever(event);
  }
}
