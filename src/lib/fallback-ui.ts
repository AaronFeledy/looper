import { notify, type LoopState } from "./state.ts";
import { stopFileExists } from "./state-files.ts";

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function resumeTime(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toLocaleTimeString();
}

function sectionTimestamp(): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date())
    .toLowerCase();
}

function terminalWidth(): number {
  return Math.max(40, process.stdout.columns ?? 80);
}

function color(code: string, text: string): string {
  if (process.env.NO_COLOR || (!process.stdout.isTTY && !process.stderr.isTTY)) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

export const ui = {
  dim: (text: string) => color("2", text),
  cyan: (text: string) => color("36", text),
  green: (text: string) => color("32", text),
  yellow: (text: string) => color("33", text),
  magenta: (text: string) => color("35", text),
  bold: (text: string) => color("1", text),
};

export function label(name: string, value: string): string {
  return `${ui.dim(name.padEnd(14, " "))} ${value}`;
}

export function divider(title: string, colorize: (text: string) => string = ui.cyan): string {
  const prefix = `╭─ ${title} `;
  const timestamp = sectionTimestamp();
  const dashes = "─".repeat(Math.max(1, terminalWidth() - prefix.length - timestamp.length - 1));
  return `${colorize(prefix)}${ui.dim(dashes)} ${ui.dim(timestamp)}\n`;
}

export async function waitWithCountdown(state: LoopState, seconds: number, labelText: string, isTty = false): Promise<void> {
  const startedAt = Date.now();
  while (elapsedSeconds(startedAt) < seconds && !state.quitting && !stopFileExists()) {
    if (!isTty) {
      const remaining = Math.max(0, seconds - elapsedSeconds(startedAt));
      process.stderr.write(`${ui.yellow("⏳ waiting")} ${remaining}s ${ui.dim("·")} ${labelText} ${ui.dim("· resumes")} ${resumeTime(remaining)}\n`);
    }
    notify();
    await Bun.sleep(isTty ? 250 : Math.min(15, Math.max(1, seconds)) * 1000);
  }
}
