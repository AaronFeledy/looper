import type { Event, Message, Part } from "@opencode-ai/sdk/v2";

export type EventConsumerCallbacks = {
  pushLine: (line: string) => void;
  pushLines?: (lines: string[]) => void;
  onSessionError?: (message: string) => void;
  onFirstAssistantContent?: () => void;
  /** Fires for every event off the stream (before any session filter); a liveness signal for stall detection. */
  onActivity?: () => void;
};

type TextPartState = {
  kind: "text" | "reasoning";
  buffer: string;
  flushed: number;
  headerPrinted: boolean;
};

type ToolPartState = {
  kind: "tool";
  tool: string;
  status: string;
  callPrinted: boolean;
};

type MarkerPartState = {
  kind: "step-start" | "step-finish";
};

type PartState = TextPartState | ToolPartState | MarkerPartState;

type PendingPartDelta = {
  partID: string;
  field: string;
  delta: string;
};

function eventSessionID(event: Event): string | undefined {
  // Most events carry a top-level properties.sessionID. The stream is global
  // (subscribed per repo directory, not per session), so this id is the only
  // thing isolating this session's output from concurrent background sub-sessions.
  // Fall back to the part's own sessionID for part events so a foreign part is
  // never mistaken for session-less just because the top-level field is absent.
  const props = (event as { properties?: { sessionID?: string; part?: { sessionID?: string } } }).properties;
  return props?.sessionID ?? props?.part?.sessionID;
}

function formatInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return json.length <= 200 ? json : `${json.slice(0, 200)}…`;
}

function color(code: string, text: string): string {
  if (process.env.NO_COLOR || (!process.stdout.isTTY && !process.stderr.isTTY)) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

/** opencode assistant errors that represent a deliberate abort, not a step failure. */
function isAbortMessageError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "MessageAbortedError";
}

function formatMessageError(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.length > 0 ? record.name : "Error";
  const data = record.data;
  const message =
    data && typeof data === "object" && "message" in data
      ? String((data as { message: unknown }).message)
      : "message" in record
        ? String(record.message)
        : undefined;
  return message === undefined || message === name ? name : `${name}: ${message}`;
}

function sectionTimestamp(): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date())
    .toLowerCase();
}

function terminalWidth(): number {
  return Math.max(40, process.stdout.columns ?? 80);
}

const ui = {
  dim: (text: string) => color("2", text),
  cyan: (text: string) => color("36", text),
  green: (text: string) => color("32", text),
  yellow: (text: string) => color("33", text),
  red: (text: string) => color("31", text),
  magenta: (text: string) => color("35", text),
  bold: (text: string) => color("1", text),
};

function groupHeader(title: string, accent: (text: string) => string): string {
  const prefix = `╭─ ${title}`;
  const timestamp = sectionTimestamp();
  const gap = " ".repeat(Math.max(1, terminalWidth() - prefix.length - timestamp.length));
  return `${accent(prefix)}${gap}${ui.dim(timestamp)}`;
}

function groupLine(text: string): string {
  return `${ui.dim("│")} ${text}`;
}

function prefixFor(kind: "text" | "reasoning"): string {
  return kind === "reasoning" ? `${ui.dim("│")} ` : "";
}

function printTextHeader(state: TextPartState, push: (line: string) => void): void {
  if (state.headerPrinted) return;
  state.headerPrinted = true;
  const title = state.kind === "reasoning" ? "Reasoning" : "Assistant";
  const accent = state.kind === "reasoning" ? ui.magenta : ui.cyan;
  push(groupHeader(title, accent));
}

function flushNewlines(state: TextPartState, push: (line: string) => void): void {
  const prefix = prefixFor(state.kind);
  while (true) {
    const nl = state.buffer.indexOf("\n", state.flushed);
    if (nl === -1) break;
    printTextHeader(state, push);
    push(prefix + state.buffer.slice(state.flushed, nl));
    state.flushed = nl + 1;
  }
}

function flushRemaining(state: TextPartState, push: (line: string) => void): void {
  if (state.flushed < state.buffer.length) {
    printTextHeader(state, push);
    push(prefixFor(state.kind) + state.buffer.slice(state.flushed));
    state.flushed = state.buffer.length;
  }
}

function syncTextLikePart(
  parts: Map<string, PartState>,
  partID: string,
  kind: "text" | "reasoning",
  fullText: string,
  push: (line: string) => void,
): void {
  let state = parts.get(partID);
  if (!state || state.kind !== kind) {
    state = { kind, buffer: "", flushed: 0, headerPrinted: false };
    parts.set(partID, state);
  }
  const textState = state as TextPartState;
  if (fullText.length > textState.buffer.length) textState.buffer = fullText;
  flushNewlines(textState, push);
}

function handlePartUpdate(
  parts: Map<string, PartState>,
  part: Part,
  push: (line: string) => void,
  pushLines: (lines: string[]) => void,
): void {
  switch (part.type) {
    case "step-start": {
      if (parts.has(part.id)) return;
      parts.set(part.id, { kind: "step-start" });
      push(groupHeader("OpenCode step", ui.cyan));
      return;
    }
    case "step-finish": {
      if (parts.has(part.id)) return;
      parts.set(part.id, { kind: "step-finish" });
      // step-finish payloads are required-shaped per the SDK type, but this is a
      // system boundary (live opencode stream): guard every field so a partial /
      // schema-drifted payload degrades gracefully instead of crashing or
      // printing NaN/undefined into the stream.
      const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
      const reason = typeof part.reason === "string" && part.reason.length > 0 ? part.reason : "unknown";
      const t = part.tokens;
      const cache = t?.cache;
      push(
        `${ui.green("✓ step done")} ${ui.dim("reason=")}${reason} ${ui.dim("cost=")}$${num(part.cost).toFixed(4)} ${ui.dim("tokens=")}in ${num(t?.input)} / out ${num(t?.output)} / think ${num(t?.reasoning)} ${ui.dim("cache=")}r ${num(cache?.read)} / w ${num(cache?.write)}`,
      );
      return;
    }
    case "text":
    case "reasoning": {
      syncTextLikePart(parts, part.id, part.type, part.text, push);
      if (part.time?.end !== undefined) {
        const state = parts.get(part.id);
        if (state && (state.kind === "text" || state.kind === "reasoning")) flushRemaining(state, push);
      }
      return;
    }
    case "tool": {
      const prev = parts.get(part.id);
      const status = part.state.status;
      const state = part.state as { input?: Record<string, unknown>; output?: string; error?: string };
      const hasInput = state.input !== undefined && Object.keys(state.input).length > 0;

      if (prev && prev.kind === "tool" && prev.status === status) {
        if (status !== "pending" || prev.callPrinted || !hasInput) return;
      }

      let callPrinted = prev && prev.kind === "tool" ? prev.callPrinted : false;
      const printCall = (): void => {
        if (callPrinted) return;
        push(`${ui.yellow("◌ tool")} ${ui.bold(part.tool)} ${ui.dim(formatInput(state.input ?? {}))}`);
        callPrinted = true;
      };
      if (status === "pending") {
        if (hasInput) printCall();
      } else if (status === "running") {
        printCall();
      } else if (status === "completed") {
        printCall();
        const outputLines = [groupHeader(`Tool output · ${part.tool}`, ui.green)];
        const lines = (state.output ?? "")
          .split("\n")
          .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
          .filter((line) => line.length > 0);
        if (lines.length === 0) outputLines.push(groupLine(ui.dim("(no output)")));
        for (const line of lines) outputLines.push(groupLine(line));
        pushLines(outputLines);
      } else if (status === "error") {
        printCall();
        push(`${ui.red("✗ tool failed")} ${ui.bold(part.tool)} ${state.error ?? ""}`);
      }
      parts.set(part.id, { kind: "tool", tool: part.tool, status, callPrinted });
      return;
    }
    default:
      return;
  }
}

function handlePartDelta(
  parts: Map<string, PartState>,
  partID: string,
  field: string,
  delta: string,
  push: (line: string) => void,
): void {
  const state = parts.get(partID);
  if (!state) return;
  if (state.kind !== "text" && state.kind !== "reasoning") return;
  if (field !== "text") return;
  state.buffer += delta;
  flushNewlines(state, push);
}

export type SessionEventConsumer = {
  consume: (stream: AsyncIterable<Event>) => Promise<void>;
  backfill: (messages: { info: Message; parts: Part[] }[]) => void;
  flush: () => void;
};

export function createSessionEventConsumer(
  sessionID: string,
  callbacks: EventConsumerCallbacks,
): SessionEventConsumer {
  const parts = new Map<string, PartState>();
  const messageRoles = new Map<string, "user" | "assistant">();
  const partMessages = new Map<string, string>();
  const pendingPartUpdates = new Map<string, Part[]>();
  const pendingPartDeltas = new Map<string, PendingPartDelta[]>();
  const printedMessageErrors = new Set<string>();
  const push = callbacks.pushLine;
  const pushLines = callbacks.pushLines ?? ((lines: string[]) => {
    for (const line of lines) push(line);
  });
  const onFirstAssistantContent = callbacks.onFirstAssistantContent;
  const onActivity = callbacks.onActivity;
  let firstContentFired = false;
  const fireFirstContent = (): void => {
    if (firstContentFired || onFirstAssistantContent === undefined) return;
    firstContentFired = true;
    onFirstAssistantContent();
  };
  const debug = process.env.LOOPER_DEBUG_EVENTS === "1";

  const roleForPart = (messageID: string): "user" | "assistant" | undefined => messageRoles.get(messageID);

  const printAssistantMessageError = (info: Message): void => {
    if (info.role !== "assistant" || printedMessageErrors.has(info.id)) return;
    const error = (info as { error?: unknown }).error;
    const message = formatMessageError(error);
    if (message === undefined) return;
    printedMessageErrors.add(info.id);
    if (isAbortMessageError(error)) {
      push(`${ui.dim(`(aborted) ${message}`)}`);
      return;
    }
    push(`${ui.red("✗ assistant error")} ${message}`);
    callbacks.onSessionError?.(message);
  };

  const replayPendingAssistantParts = (messageID: string): void => {
    if (roleForPart(messageID) !== "assistant") return;
    const updates = pendingPartUpdates.get(messageID) ?? [];
    for (const part of updates) {
      handlePartUpdate(parts, part, push, pushLines);
      if (part.type === "text") fireFirstContent();
    }
    pendingPartUpdates.delete(messageID);

    const deltas = pendingPartDeltas.get(messageID) ?? [];
    for (const delta of deltas) {
      handlePartDelta(parts, delta.partID, delta.field, delta.delta, push);
      if (delta.field === "text") fireFirstContent();
    }
    pendingPartDeltas.delete(messageID);
  };

  const dropPendingUserParts = (messageID: string): void => {
    if (roleForPart(messageID) !== "user") return;
    pendingPartUpdates.delete(messageID);
    pendingPartDeltas.delete(messageID);
  };

  const handleEvent = (event: Event): void => {
    onActivity?.();
    const evSid = eventSessionID(event);
    if (debug) push(`[debug] event=${event.type} sid=${evSid ?? "-"}`);
    if (evSid !== undefined && evSid !== sessionID) return;

    switch (event.type) {
      case "message.updated": {
        messageRoles.set(event.properties.info.id, event.properties.info.role);
        printAssistantMessageError(event.properties.info);
        replayPendingAssistantParts(event.properties.info.id);
        dropPendingUserParts(event.properties.info.id);
        break;
      }
      case "message.part.updated": {
        const part = event.properties.part;
        partMessages.set(part.id, part.messageID);
        const role = roleForPart(part.messageID);
        if (role === "user") break;
        if (role === undefined) {
          const pending = pendingPartUpdates.get(part.messageID) ?? [];
          pending.push(part);
          pendingPartUpdates.set(part.messageID, pending);
          break;
        }
        handlePartUpdate(parts, part, push, pushLines);
        if (part.type === "text") fireFirstContent();
        break;
      }
      case "message.part.delta": {
        const messageID = event.properties.messageID;
        partMessages.set(event.properties.partID, messageID);
        const role = roleForPart(messageID);
        if (role === "user") break;
        if (role === undefined) {
          const pending = pendingPartDeltas.get(messageID) ?? [];
          pending.push({ partID: event.properties.partID, field: event.properties.field, delta: event.properties.delta });
          pendingPartDeltas.set(messageID, pending);
          break;
        }
        handlePartDelta(parts, event.properties.partID, event.properties.field, event.properties.delta, push);
        if (event.properties.field === "text") fireFirstContent();
        break;
      }
      case "message.part.removed":
        parts.delete(event.properties.partID);
        partMessages.delete(event.properties.partID);
        break;
      case "session.error": {
        if (evSid !== sessionID) break;
        const err = event.properties.error;
        const message = err && typeof err === "object" && "message" in err ? String(err.message) : JSON.stringify(err);
        push(`${ui.red("✗ session error")} ${message}`);
        callbacks.onSessionError?.(message);
        break;
      }
      case "session.next.retried":
        push(`${ui.yellow(`↻ retry ${event.properties.attempt}`)} ${event.properties.error.message}`);
        break;
      default:
        break;
    }
  };

  return {
    consume: async (stream: AsyncIterable<Event>): Promise<void> => {
      for await (const event of stream) handleEvent(event);
    },
    backfill: (messages: { info: Message; parts: Part[] }[]): void => {
      onActivity?.();
      for (const entry of messages) {
        const info = entry.info;
        messageRoles.set(info.id, info.role);
        printAssistantMessageError(info);
        if (info.role !== "assistant") {
          dropPendingUserParts(info.id);
          continue;
        }
        for (const part of entry.parts) {
          partMessages.set(part.id, part.messageID);
          handlePartUpdate(parts, part, push, pushLines);
          if (part.type === "text") fireFirstContent();
        }
        replayPendingAssistantParts(info.id);
      }
    },
    flush: (): void => {
      for (const [partID, state] of parts) {
        if (state.kind !== "text" && state.kind !== "reasoning") continue;
        const messageID = partMessages.get(partID);
        if (messageID && roleForPart(messageID) === "user") continue;
        flushRemaining(state, push);
      }
    },
  };
}

export async function consumeSessionEvents(
  stream: AsyncIterable<Event>,
  sessionID: string,
  callbacks: EventConsumerCallbacks,
): Promise<void> {
  const consumer = createSessionEventConsumer(sessionID, callbacks);
  await consumer.consume(stream);
  consumer.flush();
}

export function renderSessionMessages(messages: { info: Message; parts: Part[] }[]): string[] {
  const lines: string[] = [];
  const partsMap = new Map<string, PartState>();
  const push = (line: string) => lines.push(line);
  const pushLines = (xs: string[]) => {
    for (const line of xs) lines.push(line);
  };

  for (const entry of messages) {
    if (entry.info.role !== "assistant") continue;
    for (const part of entry.parts) handlePartUpdate(partsMap, part, push, pushLines);
  }

  for (const state of partsMap.values()) {
    if (state.kind === "text" || state.kind === "reasoning") flushRemaining(state, push);
  }

  return lines;
}
