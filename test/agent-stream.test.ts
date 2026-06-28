import { describe, expect, test } from "bun:test";

import { parseOutputBlocks, type OutputBlock } from "../src/tui/agent-stream.ts";

function times(lines: string[]): number[] {
  return lines.map((_, i) => 1000 + i);
}

function looperBlocks(blocks: OutputBlock[]): Extract<OutputBlock, { kind: "looper" }>[] {
  return blocks.filter((b): b is Extract<OutputBlock, { kind: "looper" }> => b.kind === "looper");
}

describe("parseOutputBlocks — step markers and tool merge", () => {
  test("an OpenCode step header becomes a step-start block, not an empty group", () => {
    const lines = ["╭─ OpenCode step                      1:05 pm"];
    const blocks = parseOutputBlocks(lines, times(lines));
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.kind).toBe("step-start");
    expect(blocks.some((b) => b.kind === "group")).toBe(false);
  });

  test("a ✓ step done line becomes a step-finish block carrying the summary, not a plain lines block", () => {
    const lines = ["✓ step done reason=tool-calls cost=$0.0000 tokens=in 1 / out 142"];
    const blocks = parseOutputBlocks(lines, times(lines));
    expect(blocks.length).toBe(1);
    const finish = blocks[0]!;
    expect(finish.kind).toBe("step-finish");
    if (finish.kind === "step-finish") expect(finish.summary).toContain("step done");
  });

  test("one tool call line plus its output coalesce into a single done tool block", () => {
    const lines = [
      '◌ tool bash {"command":"git status"}',
      "╭─ Tool output · bash                 1:05 pm",
      "│ clean",
    ];
    const blocks = parseOutputBlocks(lines, times(lines));
    const tools = blocks.filter((b): b is Extract<OutputBlock, { kind: "tool" }> => b.kind === "tool");
    expect(tools.length).toBe(1);
    expect(tools[0]!.status).toBe("done");
    expect(tools[0]!.outputLines.join("\n")).toContain("clean");
  });

  test("retained full-output path remains visible in the tool block", () => {
    const lines = [
      '◌ tool bash {"command":"big"}',
      "╭─ Tool output · bash                 1:05 pm",
      "│ truncated",
      "│ retained full output: /tmp/full-output.txt",
    ];
    const blocks = parseOutputBlocks(lines, times(lines));
    const tool = blocks.find((b): b is Extract<OutputBlock, { kind: "tool" }> => b.kind === "tool");

    expect(tool).toBeDefined();
    expect(tool!.outputLines).toContain("retained full output: /tmp/full-output.txt");
  });

  test("a full step (start, tool, finish) yields start → tool → finish with the tool un-nested", () => {
    const lines = [
      "╭─ OpenCode step                      1:05 pm",
      '◌ tool bash {"command":"git status"}',
      "╭─ Tool output · bash                 1:05 pm",
      "│ clean",
      "✓ step done reason=tool-calls cost=$0.0000",
    ];
    const blocks = parseOutputBlocks(lines, times(lines));
    expect(blocks.map((b) => b.kind)).toEqual(["step-start", "tool", "step-finish"]);
  });
});

describe("parseOutputBlocks — [looper] lines get their own block", () => {
  test("[looper] lines are split out of the Assistant group into a dedicated looper block", () => {
    const lines = [
      "╭─ Assistant",
      "Awaiting full `bun test` background completion before marking/committing the story.",
      "[looper] prompt completed",
      "[looper] background tasks active after opencode exit: session=ses_x state=active",
      "[looper] Build failed: background task wait ended with stale — not retrying: retry suppressed",
    ];

    const blocks = parseOutputBlocks(lines, times(lines));

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
    const lines = ["[looper] a", "plain agent text", "[looper] b"];

    const blocks = parseOutputBlocks(lines, times(lines));

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
    const lines = ["[looper] one", "[looper] two"];

    const blocks = parseOutputBlocks(lines, times(lines));

    const loopers = looperBlocks(blocks);
    expect(loopers.length).toBe(1);
    expect(loopers[0]!.lines).toEqual(["[looper] one", "[looper] two"]);
  });
});
