import type { Event, Message, Part } from "@opencode-ai/sdk/v2";

import type { LooperEvent } from "../core/events.ts";
import { formatLooperEvent } from "../presentation/legacy-line-format.ts";

type PermissionAskedProperties = Extract<Event, { type: "permission.asked" }>["properties"];
type QuestionAskedProperties = Extract<Event, { type: "question.asked" }>["properties"];

export type PermissionAskedPayload = {
  requestID: PermissionAskedProperties["id"];
  sessionID: PermissionAskedProperties["sessionID"];
  permission: PermissionAskedProperties["permission"];
  patterns: PermissionAskedProperties["patterns"];
  metadata: PermissionAskedProperties["metadata"];
};

export type PermissionRepliedPayload = Extract<Event, { type: "permission.replied" }>["properties"];

export type QuestionAskedPayload = {
  requestID: QuestionAskedProperties["id"];
  sessionID: QuestionAskedProperties["sessionID"];
  questions: QuestionAskedProperties["questions"];
};

export type QuestionRepliedPayload = Extract<Event, { type: "question.replied" }>["properties"];
export type QuestionRejectedPayload = Extract<Event, { type: "question.rejected" }>["properties"];
export type SessionIdlePayload = Extract<Event, { type: "session.idle" }>["properties"];
export type TodoUpdatedPayload = Extract<Event, { type: "todo.updated" }>["properties"];

export type EventConsumerCallbacks = {
  pushLine: (line: string) => void;
  pushLines?: (lines: string[]) => void;
  onEvent?: (event: LooperEvent) => void;
  onSessionError?: (message: string) => void;
  onFirstAssistantContent?: () => void;
  onPermissionAsked?: (payload: PermissionAskedPayload) => void;
  onPermissionReplied?: (payload: PermissionRepliedPayload) => void;
  onQuestionAsked?: (payload: QuestionAskedPayload) => void;
  onQuestionReplied?: (payload: QuestionRepliedPayload) => void;
  onQuestionRejected?: (payload: QuestionRejectedPayload) => void;
  onSessionIdle?: (payload: SessionIdlePayload) => void;
  onTodoUpdated?: (payload: TodoUpdatedPayload) => void;
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

function retainedOutputPath(state: { metadata?: Record<string, unknown> }, part: { metadata?: Record<string, unknown> }): string | undefined {
  const metadata = state.metadata ?? part.metadata;
  const candidates = [
    metadata?.outputPath,
    metadata?.retainedOutputPath,
    metadata?.retainedPath,
    metadata?.fullOutputPath,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0);
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

type EventDelivery = "line" | "lines";
type EmitLooperEvent = (event: LooperEvent, delivery?: EventDelivery) => void;

type LineEmitterOptions = {
  readonly pushLine: (line: string) => void;
  readonly pushLines?: (lines: string[]) => void;
  readonly onEvent?: (event: LooperEvent) => void;
};

function createLineEmitter(options: LineEmitterOptions): EmitLooperEvent {
  const pushLines = options.pushLines ?? ((lines: string[]) => {
    for (const line of lines) options.pushLine(line);
  });
  return (event, delivery = "line") => {
    options.onEvent?.(event);
    const lines = formatLooperEvent(event);
    if (delivery === "lines") {
      pushLines(lines);
      return;
    }
    for (const line of lines) options.pushLine(line);
  };
}

function textStartedEvent(kind: "text" | "reasoning"): LooperEvent {
  return kind === "reasoning" ? { kind: "reasoning.started" } : { kind: "assistant.started" };
}

function textChunkEvent(kind: "text" | "reasoning", text: string): LooperEvent {
  return kind === "reasoning" ? { kind: "reasoning.text", text } : { kind: "assistant.text", text };
}

function printTextHeader(state: TextPartState, emit: EmitLooperEvent): void {
  if (state.headerPrinted) return;
  state.headerPrinted = true;
  emit(textStartedEvent(state.kind));
}

function flushNewlines(state: TextPartState, emit: EmitLooperEvent): void {
  while (true) {
    const nl = state.buffer.indexOf("\n", state.flushed);
    if (nl === -1) break;
    printTextHeader(state, emit);
    emit(textChunkEvent(state.kind, state.buffer.slice(state.flushed, nl)));
    state.flushed = nl + 1;
  }
}

function flushRemaining(state: TextPartState, emit: EmitLooperEvent): void {
  if (state.flushed < state.buffer.length) {
    printTextHeader(state, emit);
    emit(textChunkEvent(state.kind, state.buffer.slice(state.flushed)));
    state.flushed = state.buffer.length;
  }
}

type TextPartInput = {
  readonly partID: string;
  readonly kind: "text" | "reasoning";
  readonly fullText: string;
};

function syncTextLikePart(parts: Map<string, PartState>, input: TextPartInput, emit: EmitLooperEvent): void {
  let state = parts.get(input.partID);
  if (!state || state.kind !== input.kind) {
    state = { kind: input.kind, buffer: "", flushed: 0, headerPrinted: false };
    parts.set(input.partID, state);
  }
  const textState = state as TextPartState;
  if (input.fullText.length > textState.buffer.length) textState.buffer = input.fullText;
  flushNewlines(textState, emit);
}

function handlePartUpdate(parts: Map<string, PartState>, part: Part, emit: EmitLooperEvent): void {
  switch (part.type) {
    case "step-start": {
      if (parts.has(part.id)) return;
      parts.set(part.id, { kind: "step-start" });
      emit({ kind: "step.started" });
      return;
    }
    case "step-finish": {
      if (parts.has(part.id)) return;
      parts.set(part.id, { kind: "step-finish" });
      // step-finish payloads are required-shaped per the SDK type, but this is a
      // system boundary (live opencode stream): guard every field so a partial /
      // schema-drifted payload degrades gracefully instead of crashing or
      // printing NaN/undefined into the stream.
      const reason = typeof part.reason === "string" && part.reason.length > 0 ? part.reason : "unknown";
      const t = part.tokens;
      const cache = t?.cache;
      emit({
        kind: "step.done",
        reason,
        cost: finiteNumber(part.cost),
        tokens: {
          input: finiteNumber(t?.input),
          output: finiteNumber(t?.output),
          reasoning: finiteNumber(t?.reasoning),
          cacheRead: finiteNumber(cache?.read),
          cacheWrite: finiteNumber(cache?.write),
        },
      });
      return;
    }
    case "text":
    case "reasoning": {
      syncTextLikePart(parts, { partID: part.id, kind: part.type, fullText: part.text }, emit);
      if (part.time?.end !== undefined) {
        const state = parts.get(part.id);
        if (state && (state.kind === "text" || state.kind === "reasoning")) flushRemaining(state, emit);
      }
      return;
    }
    case "tool": {
      const prev = parts.get(part.id);
      const status = part.state.status;
      const state = part.state as { input?: Record<string, unknown>; output?: string; error?: string; metadata?: Record<string, unknown> };
      const hasInput = state.input !== undefined && Object.keys(state.input).length > 0;

      if (prev && prev.kind === "tool" && prev.status === status) {
        if (status !== "pending" || prev.callPrinted || !hasInput) return;
      }

      let callPrinted = prev && prev.kind === "tool" ? prev.callPrinted : false;
      const printCall = (): void => {
        if (callPrinted) return;
        emit({ kind: "tool.started", tool: part.tool, input: state.input ?? {} });
        callPrinted = true;
      };
      if (status === "pending") {
        if (hasInput) printCall();
      } else if (status === "running") {
        printCall();
      } else if (status === "completed") {
        printCall();
        const retainedPath = retainedOutputPath(state, part as { metadata?: Record<string, unknown> });
        emit({ kind: "tool.done", tool: part.tool, output: state.output ?? "", ...(retainedPath !== undefined ? { retainedOutputPath: retainedPath } : {}) }, "lines");
      } else if (status === "error") {
        printCall();
        emit({ kind: "tool.failed", tool: part.tool, error: state.error ?? "" });
      }
      parts.set(part.id, { kind: "tool", tool: part.tool, status, callPrinted });
      return;
    }
    default:
      return;
  }
}

function handlePartDelta(parts: Map<string, PartState>, delta: PendingPartDelta, emit: EmitLooperEvent): void {
  const state = parts.get(delta.partID);
  if (!state) return;
  if (state.kind !== "text" && state.kind !== "reasoning") return;
  if (delta.field !== "text") return;
  state.buffer += delta.delta;
  flushNewlines(state, emit);
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
  const seenPermissionRequests = new Set<string>();
  const seenQuestionRequests = new Set<string>();
  const emit = createLineEmitter(callbacks);
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
      emit({ kind: "assistant.aborted", message });
      return;
    }
    emit({ kind: "assistant.error", message });
    callbacks.onSessionError?.(message);
  };

  const replayPendingAssistantParts = (messageID: string): void => {
    if (roleForPart(messageID) !== "assistant") return;
    const updates = pendingPartUpdates.get(messageID) ?? [];
    for (const part of updates) {
      handlePartUpdate(parts, part, emit);
      if (part.type === "text") fireFirstContent();
    }
    pendingPartUpdates.delete(messageID);

    const deltas = pendingPartDeltas.get(messageID) ?? [];
    for (const delta of deltas) {
      handlePartDelta(parts, delta, emit);
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
    if (debug) emit({ kind: "debug.event", eventType: event.type, ...(evSid !== undefined ? { sessionID: evSid } : {}) });
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
        handlePartUpdate(parts, part, emit);
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
        handlePartDelta(parts, { partID: event.properties.partID, field: event.properties.field, delta: event.properties.delta }, emit);
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
        emit({ kind: "session.error", message });
        callbacks.onSessionError?.(message);
        break;
      }
      case "session.next.retried":
        emit({ kind: "retry", attempt: event.properties.attempt, message: event.properties.error.message });
        break;
      case "permission.asked": {
        const props = event.properties;
        if (seenPermissionRequests.has(props.id)) break;
        seenPermissionRequests.add(props.id);
        callbacks.onPermissionAsked?.({
          requestID: props.id,
          sessionID: props.sessionID,
          permission: props.permission,
          patterns: props.patterns,
          metadata: props.metadata,
        });
        break;
      }
      case "permission.replied":
        callbacks.onPermissionReplied?.(event.properties);
        break;
      case "question.asked": {
        const props = event.properties;
        if (seenQuestionRequests.has(props.id)) break;
        seenQuestionRequests.add(props.id);
        callbacks.onQuestionAsked?.({
          requestID: props.id,
          sessionID: props.sessionID,
          questions: props.questions,
        });
        break;
      }
      case "question.replied":
        callbacks.onQuestionReplied?.(event.properties);
        break;
      case "question.rejected":
        callbacks.onQuestionRejected?.(event.properties);
        break;
      case "session.idle":
        callbacks.onSessionIdle?.(event.properties);
        break;
      case "todo.updated":
        callbacks.onTodoUpdated?.(event.properties);
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
          handlePartUpdate(parts, part, emit);
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
        flushRemaining(state, emit);
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
  const emit = createLineEmitter({
    pushLine: (line) => lines.push(line),
    pushLines: (xs) => {
      for (const line of xs) lines.push(line);
    },
  });

  for (const entry of messages) {
    if (entry.info.role !== "assistant") continue;
    for (const part of entry.parts) handlePartUpdate(partsMap, part, emit);
  }

  for (const state of partsMap.values()) {
    if (state.kind === "text" || state.kind === "reasoning") flushRemaining(state, emit);
  }

  return lines;
}

export function renderSessionEvents(messages: { info: Message; parts: Part[] }[]): LooperEvent[] {
  const events: LooperEvent[] = [];
  const partsMap = new Map<string, PartState>();
  const emit: EmitLooperEvent = (event) => {
    events.push(event);
  };

  for (const entry of messages) {
    if (entry.info.role !== "assistant") continue;
    for (const part of entry.parts) handlePartUpdate(partsMap, part, emit);
  }

  for (const state of partsMap.values()) {
    if (state.kind === "text" || state.kind === "reasoning") flushRemaining(state, emit);
  }

  return events;
}
