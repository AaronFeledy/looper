import { describe, expect, setSystemTime, test } from "bun:test";
import type { Event, Message, Part } from "@opencode-ai/sdk/v2";

import { consumeSessionEvents, createSessionEventConsumer, renderSessionMessages } from "../src/lib/event-consumer.ts";
import type { LooperEvent } from "../src/core/events.ts";
import { formatLooperEvent } from "../src/presentation/legacy-line-format.ts";

const SID = "ses_test";
const OTHER_SID = "ses_other";
const MID = "msg_a";

const FULL_STREAM_LINES = [
  "╭─ OpenCode step                                                         1:05 pm",
  "╭─ Assistant                                                             1:05 pm",
  "hello",
  "",
  "world",
  "╭─ Reasoning                                                             1:05 pm",
  "│ think",
  "│ ",
  "│ more",
  "◌ tool bash {\"command\":\"printf 'clean\\\\r\\\\n\\\\nnext\\\\n'\"}",
  "╭─ Tool output · bash                                                    1:05 pm",
  "│ clean",
  "│ next",
  "│ retained full output: /tmp/full-output.txt",
  "◌ tool read {\"file\":\"empty.txt\"}",
  "╭─ Tool output · read                                                    1:05 pm",
  "│ (no output)",
  "◌ tool grep {\"pattern\":\"x\"}",
  "✗ tool failed grep exit 1",
  "✓ step done reason=tool-calls cost=$0.0123 tokens=in 12 / out 34 / think 5 cache=r 6 / w 7",
];

const ERROR_AND_RETRY_LINES = [
  "✗ assistant error APIError: provider rejected request",
  "(aborted) MessageAbortedError: aborted",
  "✗ session error transport down",
  "↻ retry 2 rate limited",
];

const DEBUG_LINES = [
  "[debug] event=message.updated sid=-",
  "[debug] event=session.idle sid=ses_other",
  "[debug] event=session.error sid=ses_test",
  "✗ session error transport down",
];

const REPLAY_LINES = [
  "╭─ Assistant                                                             1:05 pm",
  "pending",
  "tail",
];

const SYSTEM_LINES = [
  "[looper] prompt completed",
  "[error] event consumer crashed: boom",
  "[error] Build failed",
  "[looper] background tasks active after opencode exit: session=ses_bg state=active reason=waiting updatedAt=2026-07-07T18:05:00.000Z",
];

async function* makeStream(events: readonly Event[]): AsyncIterable<Event> {
  for (const event of events) yield event;
}

function sdkEvent(value: unknown): Event {
  return value as Event;
}

function sdkPart(value: unknown): Part {
  return value as Part;
}

function sdkMessage(value: unknown): Message {
  return value as Message;
}

async function withGoldenEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  setSystemTime(new Date(2026, 6, 7, 13, 5, 0));
  try {
    return await run();
  } finally {
    setSystemTime();
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
}

function messageUpdated(id: string, role: "assistant" | "user"): Event {
  return sdkEvent({ type: "message.updated", properties: { info: { id, role } } });
}

function partUpdated(part: unknown): Event {
  return sdkEvent({ type: "message.part.updated", properties: { part } });
}

function toolPart(input: { readonly id: string; readonly tool: string; readonly state: Record<string, unknown> }): Event {
  return partUpdated({ id: input.id, sessionID: SID, messageID: MID, type: "tool", tool: input.tool, state: input.state });
}

const textPart = { id: "p_text", sessionID: SID, messageID: MID, type: "text", text: "hello\n\nworld", time: { end: 1 } } as const;
const reasoningPart = { id: "p_reason", sessionID: SID, messageID: MID, type: "reasoning", text: "think\n\nmore", time: { end: 1 } } as const;
const completedToolPart = {
  id: "tool_1",
  sessionID: SID,
  messageID: MID,
  type: "tool",
  tool: "bash",
  state: {
    status: "completed",
    input: { command: "printf 'clean\\r\\n\\nnext\\n'" },
    output: "clean\r\n\nnext\n",
    metadata: { outputPath: "/tmp/full-output.txt" },
  },
} as const;

function fullStreamEvents(): Event[] {
  return [
    messageUpdated(MID, "assistant"),
    partUpdated({ id: "step_start", sessionID: SID, messageID: MID, type: "step-start" }),
    partUpdated(textPart),
    partUpdated(reasoningPart),
    toolPart({ id: "tool_1", tool: "bash", state: { status: "pending", input: {} } }),
    toolPart({ id: "tool_1", tool: "bash", state: { status: "running", input: { command: "printf 'clean\\r\\n\\nnext\\n'" } } }),
    partUpdated(completedToolPart),
    toolPart({ id: "tool_2", tool: "read", state: { status: "completed", input: { file: "empty.txt" }, output: "" } }),
    toolPart({ id: "tool_3", tool: "grep", state: { status: "error", input: { pattern: "x" }, error: "exit 1" } }),
    partUpdated({
      id: "step_finish",
      sessionID: SID,
      messageID: MID,
      type: "step-finish",
      reason: "tool-calls",
      cost: 0.01234,
      tokens: { input: 12, output: 34, reasoning: 5, cache: { read: 6, write: 7 } },
    }),
  ];
}

function errorAndRetryEvents(): Event[] {
  return [
    sdkEvent({ type: "message.updated", properties: { info: { id: "msg_err", role: "assistant", error: { name: "APIError", data: { message: "provider rejected request" } } } } }),
    sdkEvent({ type: "message.updated", properties: { info: { id: "msg_abort", role: "assistant", error: { name: "MessageAbortedError", data: { message: "aborted" } } } } }),
    sdkEvent({ type: "session.error", properties: { sessionID: SID, error: { message: "transport down" } } }),
    sdkEvent({ type: "session.next.retried", properties: { sessionID: SID, attempt: 2, error: { message: "rate limited" } } }),
  ];
}

async function captureLines(events: readonly Event[]): Promise<string[]> {
  const lines: string[] = [];
  await consumeSessionEvents(makeStream(events), SID, { pushLine: (line) => lines.push(line), pushLines: (batch) => lines.push(...batch) });
  return lines;
}

function typedEventCorpus(): LooperEvent[] {
  return [
    { kind: "step.started" },
    { kind: "assistant.started" },
    { kind: "assistant.text", text: "hello" },
    { kind: "assistant.text", text: "" },
    { kind: "assistant.text", text: "world" },
    { kind: "reasoning.started" },
    { kind: "reasoning.text", text: "think" },
    { kind: "reasoning.text", text: "" },
    { kind: "reasoning.text", text: "more" },
    { kind: "tool.started", tool: "bash", input: { command: "printf 'clean\\r\\n\\nnext\\n'" } },
    { kind: "tool.done", tool: "bash", output: "clean\r\n\nnext\n", retainedOutputPath: "/tmp/full-output.txt" },
    { kind: "tool.started", tool: "read", input: { file: "empty.txt" } },
    { kind: "tool.done", tool: "read", output: "" },
    { kind: "tool.started", tool: "grep", input: { pattern: "x" } },
    { kind: "tool.failed", tool: "grep", error: "exit 1" },
    { kind: "step.done", reason: "tool-calls", cost: 0.01234, tokens: { input: 12, output: 34, reasoning: 5, cacheRead: 6, cacheWrite: 7 } },
    { kind: "assistant.error", message: "APIError: provider rejected request" },
    { kind: "assistant.aborted", message: "MessageAbortedError: aborted" },
    { kind: "session.error", message: "transport down" },
    { kind: "retry", attempt: 2, message: "rate limited" },
    { kind: "debug.event", eventType: "message.updated" },
    { kind: "debug.event", eventType: "session.idle", sessionID: OTHER_SID },
    { kind: "looper.log", message: "prompt completed" },
    { kind: "looper.error", message: "event consumer crashed: boom" },
    { kind: "step.failed", message: "Build failed" },
    { kind: "continuation.notice", prefix: "background tasks active after opencode exit", sessionID: "ses_bg", state: "active", reason: "waiting", updatedAt: "2026-07-07T18:05:00.000Z" },
  ];
}

describe("legacy line-format golden corpus", () => {
  test("formats every cataloged LooperEvent species byte-identically", async () => {
    const lines = await withGoldenEnvironment(async () => typedEventCorpus().flatMap((event) => formatLooperEvent(event)));
    expect(lines).toEqual([...FULL_STREAM_LINES, ...ERROR_AND_RETRY_LINES, ...DEBUG_LINES.slice(0, 2), ...SYSTEM_LINES]);
  });

  test("preserves tool input truncation byte-for-byte", async () => {
    const lines = await withGoldenEnvironment(async () => formatLooperEvent({ kind: "tool.started", tool: "bash", input: { command: "x".repeat(250) } }));
    expect(lines).toEqual([`◌ tool bash {"command":"${"x".repeat(188)}…`]);
  });

  test("replays representative SDK stream with the captured legacy bytes", async () => {
    const lines = await withGoldenEnvironment(async () => captureLines(fullStreamEvents()));
    expect(lines).toEqual(FULL_STREAM_LINES);
  });

  test("exposes the typed stream through the additive onEvent callback", async () => {
    const events: LooperEvent[] = [];
    const lines = await withGoldenEnvironment(async () => {
      const captured: string[] = [];
      await consumeSessionEvents(makeStream(fullStreamEvents()), SID, {
        pushLine: (line) => captured.push(line),
        pushLines: (batch) => captured.push(...batch),
        onEvent: (event) => events.push(event),
      });
      return captured;
    });
    expect(lines).toEqual(FULL_STREAM_LINES);
    expect(events.map((event) => event.kind)).toEqual(["step.started", "assistant.started", "assistant.text", "assistant.text", "assistant.text", "reasoning.started", "reasoning.text", "reasoning.text", "reasoning.text", "tool.started", "tool.done", "tool.started", "tool.done", "tool.started", "tool.failed", "step.done"]);
  });

  test("replays assistant errors, aborts, session errors, and retry lines", async () => {
    const lines = await withGoldenEnvironment(async () => captureLines(errorAndRetryEvents()));
    expect(lines).toEqual(ERROR_AND_RETRY_LINES);
  });

  test("debug mode keeps pre-filter event lines and filters foreign payload output", async () => {
    const previousDebug = process.env.LOOPER_DEBUG_EVENTS;
    process.env.LOOPER_DEBUG_EVENTS = "1";
    try {
      const lines = await withGoldenEnvironment(async () => captureLines([
        messageUpdated(MID, "assistant"),
        sdkEvent({ type: "session.idle", properties: { sessionID: OTHER_SID } }),
        sdkEvent({ type: "session.error", properties: { sessionID: SID, error: { message: "transport down" } } }),
      ]));
      expect(lines).toEqual(DEBUG_LINES);
    } finally {
      if (previousDebug === undefined) delete process.env.LOOPER_DEBUG_EVENTS;
      else process.env.LOOPER_DEBUG_EVENTS = previousDebug;
    }
  });

  test("permission and question lifecycle fixtures remain callback-only with no line bytes", async () => {
    const lines = await withGoldenEnvironment(async () => captureLines([
      sdkEvent({ type: "permission.asked", properties: { id: "per_1", sessionID: SID, permission: "edit", patterns: ["src/**/*.ts"], metadata: { filepath: "src/lib/event-consumer.ts" } } }),
      sdkEvent({ type: "permission.replied", properties: { sessionID: SID, requestID: "per_1", reply: "once" } }),
      sdkEvent({ type: "question.asked", properties: { id: "que_1", sessionID: SID, questions: [{ question: "Continue?", header: "Continue", options: [{ label: "yes", description: "Proceed" }] }] } }),
      sdkEvent({ type: "question.replied", properties: { sessionID: SID, requestID: "que_1", answers: [["yes"]] } }),
      sdkEvent({ type: "question.rejected", properties: { sessionID: SID, requestID: "que_2" } }),
    ]));
    expect(lines).toEqual([]);
  });

  test("reconnect backfill dedup keeps pending text bytes exactly once", async () => {
    const lines = await withGoldenEnvironment(async () => {
      const captured: string[] = [];
      const consumer = createSessionEventConsumer(SID, { pushLine: (line) => captured.push(line), pushLines: (batch) => captured.push(...batch) });
      await consumer.consume(makeStream([
        partUpdated({ id: "p_late", sessionID: SID, messageID: "msg_late", type: "text", text: "pending\n" }),
        sdkEvent({ type: "message.part.delta", properties: { sessionID: SID, messageID: "msg_late", partID: "p_late", field: "text", delta: "tail\n" } }),
        messageUpdated("msg_late", "assistant"),
      ]));
      consumer.backfill([{ info: sdkMessage({ id: "msg_late", role: "assistant" }), parts: [sdkPart({ id: "p_late", sessionID: SID, messageID: "msg_late", type: "text", text: "pending\ntail\n", time: { end: 1 } })] }]);
      consumer.flush();
      return captured;
    });
    expect(lines).toEqual(REPLAY_LINES);
  });

  test("renderSessionMessages keeps the same legacy bytes for history/background consumers", async () => {
    const lines = await withGoldenEnvironment(async () => renderSessionMessages([
      { info: sdkMessage({ id: MID, role: "assistant" }), parts: [sdkPart(textPart), sdkPart(reasoningPart), sdkPart(completedToolPart)] },
    ]));
    expect(lines).toEqual(FULL_STREAM_LINES.slice(1, 14));
  });
});
