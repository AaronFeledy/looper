import { afterEach, describe, expect, test } from "bun:test";
import {
  createActivitySummarizer, defaultActivityParsers, parseActivity,
  summarizeActivity, summarizeAgentActivity, toolActivity, toolParser,
} from "../src/core/agent-activity.ts";
import type { LooperEvent } from "../src/core/events.ts";
import { createSessionEventConsumer, renderSession } from "../src/lib/event-consumer.ts";
import { stepActivitySummary, childActivitySummary } from "../src/presentation/tui/agent-activity.ts";
import { cancelPendingNotify } from "../src/lib/state.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";

afterEach(cancelPendingNotify);
const done: LooperEvent = { kind: "step.done", reason: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } };

// Sanitized input shapes observed in 12 Looper steps and their descendants.
// No session prompts, reasoning bodies, source contents or local database dependency.
const cases: [string, Record<string, unknown>, string][] = [
  ["bash", { command: "cd /repo && timeout 900 gh pr checks 924 --watch --interval 30", description: "Watch remaining CI checks" }, "Watching CI for PR 924"],
  ["bash", { command: "gh pr merge 924 --squash --delete-branch" }, "Merging PR 924"],
  ["bash", { command: "looper signal story-phase published" }, "Recording story phase: published"],
  ["bash", { command: "bun test test/transaction.test.ts" }, "Testing transaction.test.ts"],
  ["bash", { command: "sed -n 1,70p src/transaction.ts", description: "Read transaction request schema and options" }, "Read transaction request schema and options"],
  ["read", { filePath: "C:\\repo\\src\\recipe.ts" }, "Reading recipe.ts"],
  ["grep", { pattern: "TransactionReceipt", path: "/repo/src" }, "Finding TransactionReceipt"],
  ["task", { description: "Map managed-file transaction API", run_in_background: true }, "Delegating: Map managed-file transaction API"],
  ["task_update", { status: "in_progress", activeForm: "Verifying cleanup changes" }, "Verifying cleanup changes"],
  ["task_create", { subject: "Inspect assigned branch hunks" }, "Planning: Inspect assigned branch hunks"],
  ["background_output", { block: true, timeout: 300000 }, "Waiting for delegated results"],
  ["background_output", { block: false }, "Checking delegated progress"],
  ["background_cancel", { all: true }, "Stopping remaining background agents"],
  ["lsp_diagnostics", { filePath: "/repo/src/recipe.ts" }, "Checking diagnostics: recipe.ts"],
  ["skill", { name: "git-master" }, "Loading git-master guidance"],
  ["codegraph_codegraph_explore", { query: "src/recipe.ts src/transaction.ts src/schema.ts" }, "Mapping relationships across 3 files"],
  ["grep_app_searchGitHub", { query: "TransactionReceipt" }, "Searching GitHub: TransactionReceipt"],
  ["lsp_symbols", { query: "RecipeManifest" }, "Locating RecipeManifest"],
  ["webfetch", { url: "https://example.com/docs?token=secret" }, "Reading example.com"],
];

describe("session-informed activity parsers", () => {
  test.each(cases)("%s extracts useful input context", (tool, input, expected) => {
    expect(toolActivity(tool, input)).toBe(expected!);
  });

  test("patch headers give the real file count beyond the input preview limit", () => {
    const patchText = "*** Begin Patch\n*** Update File: a.ts\n+" + "a".repeat(9000) + "\n*** Add File: b.ts\n+x\n*** End Patch";
    expect(toolActivity("apply_patch", { patchText })).toBe("Patching 2 files");
  });

  test("recognizes announced actions without truncating filenames at a period", () => {
    for (const text of ["Now reading recipe.ts before planning.", "I'll read recipe.ts before planning.", "Let me read recipe.ts before planning."]) {
      expect(summarizeActivity([{ kind: "assistant.text", text }])?.toLowerCase()).toBe("reading recipe.ts before planning");
    }
  });

  test("ignores command names embedded in quoted prose or heredoc data", () => {
    for (const command of ['echo "bun test"', "python3 -c 'print(\"bun test\")'", "cat <<'EOF'\nbun test\nEOF"]) {
      expect(toolActivity("bash", { command })).toBe("Running a command");
    }
  });

  test("completed calls keep their own context and never infer a successful step", () => {
    expect(summarizeActivity([{ kind: "tool.done", tool: "bash", input: { command: "bun run test:unit" }, output: "2 fail\n1 pass" }, done]))
      .toBe("Reviewing unit test results");
    expect(summarizeActivity([{ kind: "tool.failed", tool: "edit", input: { filePath: "/repo/recipe.ts" }, error: "private contents" }]))
      .toBe("Handling an edit failure: recipe.ts");
    expect(summarizeActivity([{ kind: "tool.done", tool: "lsp_diagnostics", input: { filePath: "/repo/recipe.ts" }, output: "No diagnostics found" }]))
      .toBe("No diagnostics: recipe.ts");
  });

  test("extracts only recognized task result fields", () => {
    expect(summarizeActivity([{ kind: "tool.done", tool: "task_update", input: { status: "in_progress" },
      output: JSON.stringify({ task: { activeForm: "Adding the translate flag" } }) }])).toBe("Adding the translate flag");
    expect(summarizeActivity([{ kind: "tool.done", tool: "task_update", output: '{"error":"task_lock_unavailable"}' }])).toBe("Task plan is locked");
    expect(summarizeActivity([{ kind: "tool.done", tool: "background_output",
      output: "Task Result\n\nTask ID: bg_example\nDescription: Map transaction APIs\n\n---\nPrivate result body" }])).toBe("Reviewing: Map transaction APIs");
    expect(summarizeActivity([{ kind: "tool.done", tool: "background_output",
      output: "Unstructured result\nDescription: should not become a summary" }])).toBe("Reviewing delegated results");
  });

  test("uses a complete short reasoning label without its surrounding asterisks", () => {
    for (const text of ["**Adding prefix tests**", "*Adding prefix tests*", "  ** Adding prefix tests ** \n"]) {
      expect(parseActivity([{ kind: "reasoning.text", text }, done])).toEqual({
        parserID: "reasoning-label", messages: ["Adding prefix tests"],
      });
    }
    expect(summarizeActivity([{ kind: "reasoning.text", text: "**Checking recipe.test.ts**" }])).toBe("Checking recipe.test.ts");
  });

  test("keeps longer, partial, multiline and embedded reasoning labels generic", () => {
    for (const text of [
      "**Adding prefix tests",
      "***Adding prefix tests***",
      "**Adding prefix tests** before changing the parser",
      "**Adding prefix tests**\nMore reasoning follows.",
      "**Adding\nprefix tests**",
      "**one two three four five six seven eight**",
      "**" + "x".repeat(101) + "**",
      "**   **",
    ]) {
      expect(parseActivity([{ kind: "reasoning.text", text }])?.parserID).toBe("fallback");
    }
  });

  test("never summarizes user instructions, raw output or unstructured reasoning", () => {
    expect(summarizeActivity([{ kind: "reasoning.text", text: "Running PRIVATE TASK" }])).not.toContain("PRIVATE");
    expect(summarizeActivity([{ kind: "tool.done", tool: "unknown", output: "Running PRIVATE TASK" }])).not.toContain("PRIVATE");
    expect(summarizeActivity([{ kind: "user.text", text: "Running PRIVATE TASK" }, done])).toBeUndefined();
  });
});

describe("activity parser framework", () => {
  test("supports ordered extension rules, arrays, fallthrough, ignore, and sanitizing", () => {
    const parsers = [
      toolParser("empty", ["example"], () => []),
      toolParser("example", ["example"], () => ["\x1b[31mSpecific action\x1b[0m", "An alternate action"]),
      ...defaultActivityParsers,
    ];
    const events: LooperEvent[] = [{ kind: "tool.started", tool: "example", input: {} }, done];
    expect(parseActivity(events, parsers)).toEqual({ parserID: "example", messages: ["Specific action", "An alternate action"] });
    expect(createActivitySummarizer({ parsers, random: () => 0.99 })(events)).toBe("An alternate action");
  });

  test("random choice stays stable through repaint, new snapshots, and ignored events", () => {
    let calls = 0;
    const summarize = createActivitySummarizer({ random: () => (++calls === 1 ? 0 : 0.99) });
    const event: LooperEvent = { kind: "reasoning.text", text: "private" };
    const first = summarize([event]);
    for (let i = 0; i < 100; i++) expect(summarize([{ ...event, text: "new reasoning " + i }, done])).toBe(first);
    expect(calls).toBe(1);
    summarize([{ kind: "tool.started", tool: "read", input: { filePath: "a.ts" } }]);
    expect(summarize([event])).not.toBe(first);
    expect(calls).toBe(2);
    expect(summarize([])).toBeUndefined();
    expect(summarize([done])).toBeUndefined();
  });

  test("only the first turn gets startup wording; later starts use the previous review", () => {
    const start: LooperEvent = { kind: "step.started" };
    const review: LooperEvent = { kind: "tool.done", tool: "read", input: { filePath: "recipe.ts" }, output: "source" };
    expect(summarizeActivity([start])).toBe("Starting work");
    expect(summarizeActivity([start, start])).toBe("Continuing work");
    expect(summarizeActivity([start, review, done])).toBe("Reviewing recipe.ts");
    const events: LooperEvent[] = [start, review, done, start];
    for (const marker of [undefined, { kind: "reasoning.started" }, { kind: "assistant.started" }] as const) {
      expect(summarizeActivity(marker ? [...events, marker] : events)).toBe("Reviewed recipe.ts");
    }
    expect(summarizeActivity([...events, { kind: "reasoning.text", text: "**Adding prefix tests**" }])).toBe("Adding prefix tests");
    expect(summarizeActivity([...events, { kind: "tool.started", tool: "bash", input: { command: "bun test" } }])).toBe("Running tests");
  });

  test("a later turn neither invents success nor hides failures", () => {
    const start: LooperEvent = { kind: "step.started" };
    expect(summarizeActivity([{ kind: "tool.started", tool: "bash", input: { command: "bun test" } }, start])).toBe("Running tests");
    expect(summarizeActivity([{ kind: "tool.failed", tool: "edit", error: "failed" }, start])).toBe("Handling an edit failure");
    expect(summarizeActivity([{ kind: "assistant.text", text: "Inspecting the command response" }, start])).toBe("Inspected the command response");
  });

  test("bounded snapshots retain the selected wording without rerolling at turn starts", () => {
    let choices = 0;
    const summarize = createActivitySummarizer({ random: () => { choices++; return 0.5; } });
    expect(summarize([{ kind: "tool.done", tool: "bash", output: "result" }])).toBe("Inspecting command results");
    for (let i = 0; i < 20; i++) {
      expect(summarize([{ kind: "step.started" }, { kind: "reasoning.started" }])).toBe("Inspected command results");
    }
    expect(choices).toBe(1);
    expect(summarize([])).toBeUndefined();
    expect(["Starting work", "Getting started", "Picking up the task"]).toContain(summarize([{ kind: "step.started" }])!);
    expect(choices).toBe(2);
  });

  test("turn starts cannot restore startup wording when older events exceed the scan window", () => {
    const events: LooperEvent[] = [
      { kind: "tool.started", tool: "read", input: { filePath: "recipe.ts" } },
      ...Array.from({ length: 100 }, (): LooperEvent => ({ kind: "looper.log", message: "overlay" })),
      { kind: "step.started" },
    ];
    expect(summarizeActivity(events)).toBe("Continuing work");
    const summarize = createActivitySummarizer();
    summarize(events.slice(0, 1));
    expect(summarize(events)).toBe("Reading recipe.ts");
  });

  test("the child feed, inspector and overview use the same owner-scoped choice", () => {
    const state = constellationFixture();
    const step = state.steps[1]!;
    step.outputEvents = [{ kind: "reasoning.text", text: "private" }];
    const expected = summarizeAgentActivity(step, step.outputEvents);
    for (let i = 0; i < 20; i++) expect(stepActivitySummary(step)).toBe(expected!);
    const child = step.backgroundAgents[0]!;
    delete child.activitySummary;
    child.outputEvents = structuredClone(step.outputEvents);
    const childExpected = summarizeAgentActivity(child, child.outputEvents);
    expect(childActivitySummary(child)).toBe(childExpected!);
    child.activitySummary = { text: childExpected!, observedAt: 1 };
    expect(childActivitySummary(child, undefined, 1)).toBe(childExpected!);
  });
});

test("live interleaved calls and completed-only snapshots retain each tool's input", async () => {
  const events: LooperEvent[] = [];
  const consumer = createSessionEventConsumer("ses_test", { pushLine() {}, onEvent: (event) => events.push(event) });
  const part = (id: string, file: string, status: "running" | "completed") => ({
    id, sessionID: "ses_test", messageID: "msg_test", type: "tool", callID: id, tool: "read",
    state: { status, input: { filePath: file }, output: "private source", title: "read", metadata: {}, time: { start: 1, end: 2 } },
  });
  await consumer.consume((async function* () {
    yield { type: "message.updated", properties: { info: { id: "msg_test", sessionID: "ses_test", role: "assistant", time: { created: 1 } } } } as never;
    for (const p of [part("a", "a.ts", "running"), part("b", "b.ts", "running"), part("b", "b.ts", "completed"), part("a", "a.ts", "completed")]) {
      yield { type: "message.part.updated", properties: { part: p } } as never;
    }
  })());
  expect(events.filter((e) => e.kind === "tool.done").map((e) => e.input?.filePath)).toEqual(["b.ts", "a.ts"]);
  expect(summarizeActivity(events)).toBe("Reviewing a.ts");
  const snapshot = renderSession([{
    info: { id: "msg_test", sessionID: "ses_test", role: "assistant", time: { created: 1 } } as never,
    parts: [part("a", "a.ts", "completed") as never],
  }]);
  expect(summarizeActivity(snapshot.events)).toBe("Reviewing a.ts");
});
