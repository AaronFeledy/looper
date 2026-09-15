import { formatWithOptions } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { sanitizeTerminalText } from "./ansi.ts";
import { notify, type LoopState } from "./state.ts";

export type DiagnosticLevel = "info" | "warning" | "error";
export type DiagnosticEntry = { at: number; level: DiagnosticLevel; source: string; message: string; count: number };
export type DiagnosticsState = { entries: DiagnosticEntry[]; unread: number; dropped: number; visible: boolean };
export const DIAGNOSTIC_LIMIT = 200;
const MESSAGE_LIMIT = 8000;

export function diagnosticsFor(state: LoopState): DiagnosticsState {
  return state.diagnostics ??= { entries: [], unread: 0, dropped: 0, visible: false };
}

export function recordDiagnostic(state: LoopState, level: DiagnosticLevel, source: string, text: string): void {
  const message = sanitizeTerminalText(text.slice(0, MESSAGE_LIMIT)).trim()
    + (text.length > MESSAGE_LIMIT ? "\n[message truncated]" : "");
  if (!message) return;
  const log = diagnosticsFor(state), last = log.entries.at(-1);
  if (last?.message === message && last.level === level && last.source === source) {
    last.count++; last.at = Date.now();
  } else {
    log.entries.push({ at: Date.now(), level, source, message, count: 1 });
    if (log.entries.length > DIAGNOSTIC_LIMIT) { log.entries.shift(); log.dropped++; }
  }
  if (level !== "info") log.unread++;
  notify();
}

export function setDiagnosticsVisible(state: LoopState, visible: boolean): void {
  const log = diagnosticsFor(state);
  log.visible = visible;
  if (visible) log.unread = 0;
  notify();
}

/** Capture application text only; native terminal output and process handlers keep their ownership. */
export function captureTuiDiagnostics(state: LoopState): () => void {
  const stderr = process.stderr, originalWrite = stderr.write;
  const consoleHost = globalThis.console;
  const methods = ["log", "info", "debug", "warn", "error", "trace"] as const;
  const original = new Map(methods.map(method => [method, consoleHost[method]]));
  const replacements = new Map<string, (...args: unknown[]) => void>();
  let pending = "", truncated = false, timer: ReturnType<typeof setTimeout> | undefined;
  const decoder = new StringDecoder("utf8");
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const text = pending + (truncated ? "\n[stderr truncated]" : "");
    pending = ""; truncated = false;
    if (text.trim()) recordDiagnostic(state, /\b\w*Warning\b/.test(text) ? "warning" : "error", "stderr", text);
  };
  for (const method of methods) {
    const replacement = (...args: unknown[]) => {
      const level = method === "warn" ? "warning" : method === "error" || method === "trace" ? "error" : "info";
      const text = formatWithOptions({ colors: false, depth: 4, maxArrayLength: 50, maxStringLength: MESSAGE_LIMIT, customInspect: false }, ...args);
      // OpenTUI repeats process warnings as a JSON-quoted console.warn message
      // after the default warning writer; retain the fuller stderr diagnostic.
      if (method === "warn" && text.startsWith('"')) {
        try { if (pending.includes(JSON.parse(text))) return; } catch { /* Ordinary non-JSON warning. */ }
      }
      recordDiagnostic(state, level, `console.${method}`, text);
    };
    replacements.set(method, replacement);
    consoleHost[method] = replacement;
  }
  const write: typeof stderr.write = (chunk: any, encoding?: any, callback?: any): boolean => {
    const done = typeof encoding === "function" ? encoding : callback;
    const text = decoder.write(typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8") : Buffer.from(chunk));
    const available = Math.max(0, MESSAGE_LIMIT - pending.length);
    pending += text.slice(0, available);
    truncated ||= text.length > available;
    timer ??= setTimeout(flush, 40);
    timer.unref();
    if (typeof done === "function") queueMicrotask(() => done());
    return true;
  };
  stderr.write = write;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (stderr.write === write) stderr.write = originalWrite;
    for (const method of methods) if (consoleHost[method] === replacements.get(method)) consoleHost[method] = original.get(method)!;
    pending += decoder.end();
    flush();
  };
}
