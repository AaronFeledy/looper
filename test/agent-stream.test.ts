import { describe, expect, test } from "bun:test";

import type { LooperEvent } from "../src/core/events.ts";
import { eventsToOutputBlocks, type OutputBlock } from "../src/presentation/tui/stream-blocks.ts";

function times(events: readonly LooperEvent[]): number[] {
  return events.map((_, i) => 1000 + i);
}

function looperBlocks(blocks: OutputBlock[]): Extract<OutputBlock, { kind: "looper" }>[] {
  return blocks.filter((b): b is Extract<OutputBlock, { kind: "looper" }> => b.kind === "looper");
}

describe("eventsToOutputBlocks — step markers and tool merge", () => {
  test("an OpenCode step header becomes a step-start block, not an empty group", () => {
    const events: LooperEvent[] = [{ kind: "step.started" }];
    const blocks = eventsToOutputBlocks(events, times(events));
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.kind).toBe("step-start");
    expect(blocks.some((b) => b.kind === "group")).toBe(false);
  });

  test("a ✓ step done line becomes a step-finish block carrying the summary, not a plain lines block", () => {
    const events: LooperEvent[] = [{ kind: "step.done", reason: "tool-calls", cost: 0, tokens: { input: 1, output: 142, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }];
    const blocks = eventsToOutputBlocks(events, times(events));
    expect(blocks.length).toBe(1);
    const finish = blocks[0]!;
    expect(finish.kind).toBe("step-finish");
    if (finish.kind === "step-finish") expect(finish.summary).toContain("step done");
  });

  test("one tool call line plus its output coalesce into a single done tool block", () => {
    const events: LooperEvent[] = [
      { kind: "tool.started", tool: "bash", input: { command: "git status" } },
      { kind: "tool.done", tool: "bash", output: "clean" },
    ];
    const blocks = eventsToOutputBlocks(events, times(events));
    const tools = blocks.filter((b): b is Extract<OutputBlock, { kind: "tool" }> => b.kind === "tool");
    expect(tools.length).toBe(1);
    expect(tools[0]!.status).toBe("done");
    expect(tools[0]!.outputLines.join("\n")).toContain("clean");
  });

  test("retained full-output path remains visible in the tool block", () => {
    const events: LooperEvent[] = [
      { kind: "tool.started", tool: "bash", input: { command: "big" } },
      { kind: "tool.done", tool: "bash", output: "truncated", retainedOutputPath: "/tmp/full-output.txt" },
    ];
    const blocks = eventsToOutputBlocks(events, times(events));
    const tool = blocks.find((b): b is Extract<OutputBlock, { kind: "tool" }> => b.kind === "tool");

    expect(tool).toBeDefined();
    expect(tool!.outputLines).toContain("retained full output: /tmp/full-output.txt");
  });

  test("a full step (start, tool, finish) yields start → tool → finish with the tool un-nested", () => {
    const events: LooperEvent[] = [
      { kind: "step.started" },
      { kind: "tool.started", tool: "bash", input: { command: "git status" } },
      { kind: "tool.done", tool: "bash", output: "clean" },
      { kind: "step.done", reason: "tool-calls", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
    ];
    const blocks = eventsToOutputBlocks(events, times(events));
    expect(blocks.map((b) => b.kind)).toEqual(["step-start", "tool", "step-finish"]);
  });
});

describe("eventsToOutputBlocks — [looper] lines get their own block", () => {
  test("[looper] lines are split out of the Assistant group into a dedicated looper block", () => {
    const events: LooperEvent[] = [
      { kind: "assistant.started" },
      { kind: "assistant.text", text: "Awaiting full `bun test` background completion before marking/committing the story." },
      { kind: "looper.log", message: "prompt completed" },
      { kind: "looper.log", message: "background tasks active after opencode exit: session=ses_x state=active" },
      { kind: "looper.log", message: "Build failed: background task wait ended with stale — not retrying: retry suppressed" },
    ];

    const blocks = eventsToOutputBlocks(events, times(events));

    // The assistant group must NOT contain any [looper] line.
    const group = blocks.find((b): b is Extract<OutputBlock, { kind: "group" }> => b.kind === "group");
    expect(group).toBeDefined();
    expect(group!.title).toBe("Assistant");
    expect(group!.lines.join("\n")).toContain("Awaiting full");
    expect(group!.lines.some((l) => l.includes("[looper]"))).toBe(false);

    // All three [looper] lines coalesce into exactly one looper block, in order.
    const loopers = looperBlocks(blocks);
    expect(loopers.length).toBe(1);
    expect(loopers[0]!.lines).toEqual([
      "[looper] prompt completed",
      "[looper] background tasks active after opencode exit: session=ses_x state=active",
      "[looper] Build failed: background task wait ended with stale — not retrying: retry suppressed",
    ]);
  });

  test("a non-looper line between [looper] lines closes the block, yielding two looper blocks", () => {
    const events: LooperEvent[] = [{ kind: "looper.log", message: "a" }, { kind: "assistant.text", text: "plain agent text" }, { kind: "looper.log", message: "b" }];

    const blocks = eventsToOutputBlocks(events, times(events));

    const loopers = looperBlocks(blocks);
    expect(loopers.length).toBe(2);
    expect(loopers[0]!.lines).toEqual(["[looper] a"]);
    expect(loopers[1]!.lines).toEqual(["[looper] b"]);

    // The plain line is preserved as non-looper output.
    const nonLooper = blocks.filter((b) => b.kind !== "looper");
    const flat = nonLooper.flatMap((b) => ("lines" in b ? b.lines : []));
    expect(flat.join("\n")).toContain("plain agent text");
  });

  test("a leading run of [looper] lines (no assistant text) is a single looper block", () => {
    const events: LooperEvent[] = [{ kind: "looper.log", message: "one" }, { kind: "looper.log", message: "two" }];

    const blocks = eventsToOutputBlocks(events, times(events));

    const loopers = looperBlocks(blocks);
    expect(loopers.length).toBe(1);
    expect(loopers[0]!.lines).toEqual(["[looper] one", "[looper] two"]);
  });
});

describe("eventsToOutputBlocks — user messages", () => {
  test("user text becomes a User group block", () => {
    const events: LooperEvent[] = [
      { kind: "user.started" },
      { kind: "user.text", text: "plugin says hi" },
      { kind: "assistant.started" },
      { kind: "assistant.text", text: "assistant replies" },
    ];
    const blocks = eventsToOutputBlocks(events, times(events));
    const groups = blocks.filter((b): b is Extract<OutputBlock, { kind: "group" }> => b.kind === "group");
    expect(groups.map((g) => g.title)).toEqual(["User", "Assistant"]);
    expect(groups[0]!.lines).toEqual(["plugin says hi"]);
    expect(groups[1]!.lines).toEqual(["assistant replies"]);
  });
});
