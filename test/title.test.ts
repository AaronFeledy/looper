import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

function writeIdleContinuationRecord(repoDir: string, sessionID: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${sessionID}.json`),
    JSON.stringify({
      sessionID,
      updatedAt: now,
      sources: { "background-task": { state: "idle", updatedAt: now } },
    }),
  );
}

import { loadSteps } from "../src/lib/config.ts";
import { runIteration } from "../src/lib/orchestrator.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState } from "../src/lib/state.ts";
import { extractAssistantText, postprocessTitle } from "../src/lib/title.ts";

describe("postprocessTitle", () => {
  test("returns trimmed first non-empty line", () => {
    expect(postprocessTitle("  hello world  \nignored")).toBe("hello world");
  });

  test("strips <think>...</think> blocks before picking a line", () => {
    const input = "<think>scratch space\nplanning</think>\nReal title here\n";
    expect(postprocessTitle(input)).toBe("Real title here");
  });

  test("strips multi-line <think> blocks across newlines", () => {
    const input = "<think>\nfoo\nbar\n</think>\n  spaced title\n";
    expect(postprocessTitle(input)).toBe("spaced title");
  });

  test("truncates to 100 characters", () => {
    const long = "x".repeat(150);
    expect(postprocessTitle(long)).toBe("x".repeat(100));
  });

  test("returns empty string when input is only whitespace", () => {
    expect(postprocessTitle("   \n\n  \n")).toBe("");
  });

  test("returns empty when entire input is wrapped in <think>", () => {
    expect(postprocessTitle("<think>only reasoning</think>")).toBe("");
  });
});

describe("extractAssistantText", () => {
  test("returns only text parts from assistant messages", () => {
    const entries = [
      {
        info: { role: "user" as const, id: "u1" },
        parts: [{ type: "text" as const, text: "user message" }],
      },
      {
        info: { role: "assistant" as const, id: "a1" },
        parts: [
          { type: "reasoning" as const, text: "internal monologue" },
          { type: "text" as const, text: "Built the thing" },
          { type: "tool" as const, tool: "write", state: { status: "completed" } },
        ],
      },
    ];
    expect(extractAssistantText(entries as never)).toBe("Built the thing");
  });

  test("skips synthetic and ignored text parts", () => {
    const entries = [
      {
        info: { role: "assistant" as const },
        parts: [
          { type: "text" as const, text: "real output" },
          { type: "text" as const, text: "synthetic noise", synthetic: true },
          { type: "text" as const, text: "ignored noise", ignored: true },
        ],
      },
    ];
    expect(extractAssistantText(entries as never)).toBe("real output");
  });

  test("joins text parts from multiple assistant messages with blank lines", () => {
    const entries = [
      { info: { role: "assistant" as const }, parts: [{ type: "text" as const, text: "first" }] },
      { info: { role: "assistant" as const }, parts: [{ type: "text" as const, text: "second" }] },
    ];
    expect(extractAssistantText(entries as never)).toBe("first\n\nsecond");
  });

  test("returns empty string when no usable text parts exist", () => {
    const entries = [
      {
        info: { role: "assistant" as const },
        parts: [{ type: "reasoning" as const, text: "only reasoning" }],
      },
    ];
    expect(extractAssistantText(entries as never)).toBe("");
  });
});

describe("config title parsing", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "looper-title-cfg-"));
    writeFileSync(join(dir, "build.md"), "");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("accepts boolean true and false", () => {
    writeFileSync(
      join(dir, "looper.yaml"),
      "steps:\n  build:\n    prompt: build.md\n    title: true\n",
    );
    expect(loadSteps(dir)[0]?.title).toBe(true);

    writeFileSync(
      join(dir, "looper.yaml"),
      "steps:\n  build:\n    prompt: build.md\n    title: false\n",
    );
    expect(loadSteps(dir)[0]?.title).toBe(false);
  });

  test("accepts positive integer seconds", () => {
    writeFileSync(
      join(dir, "looper.yaml"),
      "steps:\n  build:\n    prompt: build.md\n    title: 30\n",
    );
    expect(loadSteps(dir)[0]?.title).toBe(30);
  });

  test("rejects zero, negatives, and floats", () => {
    for (const bad of ["0", "-5", "1.5"]) {
      writeFileSync(
        join(dir, "looper.yaml"),
        `steps:\n  build:\n    prompt: build.md\n    title: ${bad}\n`,
      );
      expect(() => loadSteps(dir)).toThrow(/title must be true, false, or an integer/);
    }
  });

  test("rejects non-numeric, non-boolean values", () => {
    writeFileSync(
      join(dir, "looper.yaml"),
      'steps:\n  build:\n    prompt: build.md\n    title: "yes"\n',
    );
    expect(() => loadSteps(dir)).toThrow(/title must be true, false, or an integer/);
  });

  test("defaults to undefined when omitted", () => {
    writeFileSync(
      join(dir, "looper.yaml"),
      "steps:\n  build:\n    prompt: build.md\n",
    );
    expect(loadSteps(dir)[0]?.title).toBeUndefined();
  });
});

describe("title orchestration", () => {
  let scratch: string;
  let configDir: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "looper-title-orch-"));
    configDir = join(scratch, ".local", "looper");
    mkdirSync(configDir, { recursive: true });
    initStatePaths({ configDir });
    writeFileSync(join(configDir, "build.md"), "build task\n");
    writeFileSync(join(configDir, "review.md"), "review the build\n");
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function writeTwoStepConfig(): void {
    writeFileSync(
      join(configDir, "looper.yaml"),
      [
        "steps:",
        "  build:",
        "    name: Build",
        "    agent: build",
        "    prompt: build.md",
        "    title: true",
        "  review:",
        "    name: Review",
        "    agent: build",
        "    prompt: review.md",
        "",
      ].join("\n"),
    );
  }

  function makeStubClient(opts: {
    buildSessionID: string;
    reviewSessionID: string;
    titleSessionID: string;
    titleText: string;
    capturedUpdates: Array<{ sessionID: string; title: string }>;
    capturedDeletes: string[];
  }): OpencodeClient {
    let buildAgentCreates = 0;
    const buildAssistantText = "Implemented widget X and exported it.";
    async function* stream() {
      yield {
        type: "message.updated",
        properties: { info: { id: "msg_assist", role: "assistant" } },
      };
      yield {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p_text",
            messageID: "msg_assist",
            type: "text",
            text: buildAssistantText,
          },
        },
      };
    }
    return {
      event: {
        subscribe: async () => ({ stream: stream() }),
      },
      session: {
        abort: async () => ({}),
        create: async (params?: { agent?: string }) => {
          if (params?.agent === "build") {
            buildAgentCreates += 1;
            const id = buildAgentCreates === 1 ? opts.buildSessionID : opts.reviewSessionID;
            writeIdleContinuationRecord(scratch, id);
            return { data: { id } };
          }
          return { data: { id: opts.titleSessionID } };
        },
        delete: async ({ sessionID }: { sessionID: string }) => {
          opts.capturedDeletes.push(sessionID);
          return {};
        },
        update: async ({ sessionID, title }: { sessionID: string; title: string }) => {
          opts.capturedUpdates.push({ sessionID, title });
          return {};
        },
        prompt: async (params: { sessionID: string; agent?: string }) => {
          if (params.sessionID === opts.titleSessionID) {
            return {
              data: {
                info: { role: "assistant" },
                parts: [{ type: "text", text: opts.titleText }],
              },
            };
          }
          return {};
        },
        messages: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === opts.buildSessionID) {
            return {
              data: [
                {
                  info: { role: "assistant" },
                  parts: [{ type: "text", text: buildAssistantText }],
                },
              ],
            };
          }
          return { data: [] };
        },
        status: async () => ({ data: {} }),
      },
    } as unknown as OpencodeClient;
  }

  test("title: true sets build session title and prefixes later steps", async () => {
    writeTwoStepConfig();
    const captured: Array<{ sessionID: string; title: string }> = [];
    const deletes: string[] = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: captured,
      capturedDeletes: deletes,
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });

    const result = await runIteration({
      state,
      iteration: 1,
      client,
      repoDir: scratch,
      configDir,
    });

    expect(result).toBe("complete");
    expect(captured).toEqual([
      { sessionID: "ses_build", title: "Build: Widget X export" },
      { sessionID: "ses_review", title: "Review: Widget X export" },
    ]);
    expect(deletes).toContain("ses_title");
  });

  test("no title means no title.update calls at all", async () => {
    writeFileSync(
      join(configDir, "looper.yaml"),
      [
        "steps:",
        "  build:",
        "    name: Build",
        "    agent: build",
        "    prompt: build.md",
        "  review:",
        "    name: Review",
        "    agent: build",
        "    prompt: review.md",
        "",
      ].join("\n"),
    );
    const captured: Array<{ sessionID: string; title: string }> = [];
    const deletes: string[] = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "irrelevant",
      capturedUpdates: captured,
      capturedDeletes: deletes,
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });

    const result = await runIteration({
      state,
      iteration: 1,
      client,
      repoDir: scratch,
      configDir,
    });

    expect(result).toBe("complete");
    expect(captured).toEqual([]);
    expect(deletes).toEqual([]);
  });
});
