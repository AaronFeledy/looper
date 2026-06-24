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

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

import { loadSteps } from "../src/lib/config.ts";
import { DEFAULT_STEP_TIMEOUT_MS } from "../src/lib/runner.ts";
import { runIteration } from "../src/lib/orchestrator.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState } from "../src/lib/state.ts";
import { extractAssistantText, generateWorkDescription, humanizeBranchName, isBoilerplateTitle, postprocessTitle, toBookTitleCase } from "../src/lib/title.ts";
import { TITLE_AGENT_NAME } from "../src/lib/title-agent.ts";

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

describe("title helpers", () => {
  test("humanizes story branches in book title case", () => {
    expect(humanizeBranchName("us-057-guide-frontmatter-schema")).toBe("US-057 Guide Frontmatter Schema");
    expect(humanizeBranchName("fix-pg-pool-timeout")).toBe("Fix Pg Pool Timeout");
  });

  test("applies book title case while preserving technical tokens", () => {
    expect(toBookTitleCase("dark mode toggle in app header")).toBe("Dark Mode Toggle in App Header");
    expect(toBookTitleCase("runner.ts v2.3.1 500 error fix in JWT middleware")).toBe("runner.ts v2.3.1 500 Error Fix in JWT Middleware");
  });

  test("detects boilerplate titles", () => {
    expect(isBoilerplateTitle("ULTRAWORK MODE ENABLED!")).toBe(true);
    expect(isBoilerplateTitle("I'll handle this")).toBe(true);
    expect(isBoilerplateTitle("Continuing where I left off")).toBe(true);
    expect(isBoilerplateTitle("US-057 Guide Frontmatter Schema")).toBe(false);
    expect(isBoilerplateTitle("500 Error Fix in JWT Middleware")).toBe(false);
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

describe("generateWorkDescription agent selection", () => {
  function stubClient(captured: { createAgents: Array<string | undefined>; promptAgents: Array<string | undefined> }, titleText = "A Title") {
    return {
      config: { get: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [] } }) },
      session: {
        create: async (params?: { agent?: string }) => {
          captured.createAgents.push(params?.agent);
          return { data: { id: "ses_title" } };
        },
        prompt: async (params: { agent?: string }) => {
          captured.promptAgents.push(params.agent);
          return { data: { info: { role: "assistant" }, parts: [{ type: "text", text: titleText }] } };
        },
        abort: async () => ({}),
        delete: async () => ({}),
      },
    } as unknown as OpencodeClient;
  }

  test("defaults the throwaway title session to the looper-title agent", async () => {
    const captured = { createAgents: [] as Array<string | undefined>, promptAgents: [] as Array<string | undefined> };
    const title = await generateWorkDescription({
      client: stubClient(captured),
      repoDir: "/tmp/repo",
      contextText: "did some work",
    });
    expect(title).toBe("A Title");
    expect(captured.createAgents).toEqual([TITLE_AGENT_NAME]);
    expect(captured.promptAgents).toEqual([TITLE_AGENT_NAME]);
  });

  test("an explicit opencode.title.agent overrides the default", async () => {
    const captured = { createAgents: [] as Array<string | undefined>, promptAgents: [] as Array<string | undefined> };
    await generateWorkDescription({
      client: stubClient(captured),
      repoDir: "/tmp/repo",
      contextText: "did some work",
      config: { agent: "my-custom-title-agent" },
    });
    expect(captured.createAgents).toEqual(["my-custom-title-agent"]);
    expect(captured.promptAgents).toEqual(["my-custom-title-agent"]);
  });

  test("returns accepted model titles in book title case", async () => {
    const captured = { createAgents: [] as Array<string | undefined>, promptAgents: [] as Array<string | undefined> };
    const title = await generateWorkDescription({
      client: stubClient(captured, "runner.ts 500 error fix in JWT middleware"),
      repoDir: "/tmp/repo",
      contextText: "fixed the title logic",
    });
    expect(title).toBe("runner.ts 500 Error Fix in JWT Middleware");
  });

  test("falls back to the humanized branch when the model returns boilerplate", async () => {
    const captured = { createAgents: [] as Array<string | undefined>, promptAgents: [] as Array<string | undefined> };
    const title = await generateWorkDescription({
      client: stubClient(captured, "ULTRAWORK MODE ENABLED!"),
      repoDir: "/tmp/repo",
      contextText: "ULTRAWORK MODE ENABLED!",
      branchHint: "us-057-guide-frontmatter-schema",
    });
    expect(title).toBe("US-057 Guide Frontmatter Schema");
  });

  test("rejects boilerplate model titles when no branch fallback exists", async () => {
    const captured = { createAgents: [] as Array<string | undefined>, promptAgents: [] as Array<string | undefined> };
    const title = await generateWorkDescription({
      client: stubClient(captured, "I need to pause and gather context systematically before planning"),
      repoDir: "/tmp/repo",
      contextText: "startup narration",
    });
    expect(title).toBeUndefined();
  });

  test("aborts and deletes the title session when generation exceeds the timeout", async () => {
    const prev = process.env["LOOPER_TITLE_GEN_TIMEOUT_MS"];
    process.env["LOOPER_TITLE_GEN_TIMEOUT_MS"] = "50";
    const aborts: string[] = [];
    const deletes: string[] = [];
    const client = {
      config: { get: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [] } }) },
      session: {
        create: async () => ({ data: { id: "ses_title_runaway" } }),
        prompt: (_params: unknown, opts?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
        abort: async ({ sessionID }: { sessionID: string }) => {
          aborts.push(sessionID);
          return {};
        },
        delete: async ({ sessionID }: { sessionID: string }) => {
          deletes.push(sessionID);
          return {};
        },
      },
    } as unknown as OpencodeClient;

    try {
      const title = await generateWorkDescription({ client, repoDir: "/tmp/repo", contextText: "did some work" });
      expect(title).toBeUndefined();
      expect(aborts).toContain("ses_title_runaway");
      expect(deletes).toContain("ses_title_runaway");
    } finally {
      if (prev === undefined) delete process.env["LOOPER_TITLE_GEN_TIMEOUT_MS"];
      else process.env["LOOPER_TITLE_GEN_TIMEOUT_MS"] = prev;
    }
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

  test("accepts the literal string \"branch\"", () => {
    writeFileSync(
      join(dir, "looper.yaml"),
      "steps:\n  build:\n    prompt: build.md\n    title: branch\n",
    );
    expect(loadSteps(dir)[0]?.title).toBe("branch");
  });

  test("rejects zero, negatives, and floats", () => {
    for (const bad of ["0", "-5", "1.5"]) {
      writeFileSync(
        join(dir, "looper.yaml"),
        `steps:\n  build:\n    prompt: build.md\n    title: ${bad}\n`,
      );
      expect(() => loadSteps(dir)).toThrow(/title must be true, false, "branch", or an integer/);
    }
  });

  test("rejects non-numeric, non-boolean values", () => {
    writeFileSync(
      join(dir, "looper.yaml"),
      'steps:\n  build:\n    prompt: build.md\n    title: "yes"\n',
    );
    expect(() => loadSteps(dir)).toThrow(/title must be true, false, "branch", or an integer/);
  });

  test("defaults to undefined when omitted", () => {
    writeFileSync(
      join(dir, "looper.yaml"),
      "steps:\n  build:\n    prompt: build.md\n",
    );
    expect(loadSteps(dir)[0]?.title).toBeUndefined();
  });
});

describe("config timeout parsing", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "looper-timeout-cfg-"));
    writeFileSync(join(dir, "build.md"), "");
    writeFileSync(join(dir, "review.md"), "");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("defaults to 60 minutes", () => {
    writeFileSync(join(dir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n");
    expect(loadSteps(dir)[0]?.timeoutMs).toBe(DEFAULT_STEP_TIMEOUT_MS);
  });

  test("loads .looper.yaml when looper.yaml is absent", () => {
    writeFileSync(join(dir, ".looper.yaml"), "timeout: 1h\nsteps:\n  build:\n    prompt: build.md\n");
    expect(loadSteps(dir)[0]?.timeoutMs).toBe(60 * 60 * 1000);
  });

  test("loads looper.yml", () => {
    writeFileSync(join(dir, "looper.yml"), "timeout: 2h\nsteps:\n  build:\n    prompt: build.md\n");
    expect(loadSteps(dir)[0]?.timeoutMs).toBe(2 * 60 * 60 * 1000);
  });

  test("prefers looper.yml over looper.yaml", () => {
    writeFileSync(join(dir, "looper.yml"), "timeout: 2h\nsteps:\n  build:\n    prompt: build.md\n");
    writeFileSync(join(dir, "looper.yaml"), "timeout: 1h\nsteps:\n  build:\n    prompt: build.md\n");
    expect(loadSteps(dir)[0]?.timeoutMs).toBe(2 * 60 * 60 * 1000);
  });

  test("falls back to looper.yaml when looper.yml is absent", () => {
    writeFileSync(join(dir, "looper.yaml"), "timeout: 1h\nsteps:\n  build:\n    prompt: build.md\n");
    expect(loadSteps(dir)[0]?.timeoutMs).toBe(60 * 60 * 1000);
  });

  test("reports missing config with the looked-for candidates", () => {
    expect(() => loadSteps(dir)).toThrow(/missing looper\.yml.*looper\.yaml/s);
  });

  test("applies root timeout and lets steps override it", () => {
    writeFileSync(
      join(dir, "looper.yaml"),
      [
        "timeout: 2",
        "steps:",
        "  build:",
        "    prompt: build.md",
        "  review:",
        "    prompt: review.md",
        "    timeout: 30s",
        "",
      ].join("\n"),
    );
    const steps = loadSteps(dir);
    expect(steps[0]?.timeoutMs).toBe(2 * 60 * 1000);
    expect(steps[1]?.timeoutMs).toBe(30 * 1000);
  });

  test("accepts simple duration strings", () => {
    for (const [value, expected] of [["60m", 60 * 60 * 1000], ["1h", 60 * 60 * 1000], ["30s", 30 * 1000]] as const) {
      writeFileSync(join(dir, "looper.yaml"), `timeout: ${value}\nsteps:\n  build:\n    prompt: build.md\n`);
      expect(loadSteps(dir)[0]?.timeoutMs).toBe(expected);
    }
  });

  test("rejects invalid timeout values", () => {
    for (const bad of ["0", "1.5", "soon", "5d"]) {
      writeFileSync(join(dir, "looper.yaml"), `timeout: ${bad}\nsteps:\n  build:\n    prompt: build.md\n`);
      expect(() => loadSteps(dir)).toThrow(/timeout must be an integer >= 1/);
    }
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
    capturedTitlePrompts?: string[];
    capturedTitleModels?: Array<{ providerID: string; modelID: string } | undefined>;
    smallModel?: string;
    stepProviderID?: string;
    stepModelID?: string;
    titleError?: { name: string; data?: { message?: string; statusCode?: number } };
    providerList?: { all: Array<{ id: string; models: Record<string, unknown> }> };
    /** Runs after the stream yields its events; lets tests mutate state mid-step (e.g., flip the branch) and then sleep so background timers can fire before the step completes. */
    streamPostHook?: () => Promise<void>;
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
      if (opts.streamPostHook !== undefined) await opts.streamPostHook();
    }
    return {
      config: {
        get: async () => ({ data: opts.smallModel !== undefined ? { small_model: opts.smallModel } : {} }),
      },
      provider: {
        list: async () => ({ data: opts.providerList ?? { all: [], default: {}, connected: [] } }),
      },
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
        prompt: async (params: {
          sessionID: string;
          agent?: string;
          model?: { providerID: string; modelID: string };
          parts?: Array<{ type: string; text?: string }>;
        }) => {
          if (params.sessionID === opts.titleSessionID) {
            const text = params.parts?.[0]?.text ?? "";
            opts.capturedTitlePrompts?.push(text);
            opts.capturedTitleModels?.push(params.model);
            return {
              data: {
                info: { role: "assistant", ...(opts.titleError !== undefined ? { error: opts.titleError } : {}) },
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
                  info: {
                    role: "assistant",
                    ...(opts.stepProviderID !== undefined ? { providerID: opts.stepProviderID } : {}),
                    ...(opts.stepModelID !== undefined ? { modelID: opts.stepModelID } : {}),
                  },
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
      { sessionID: "ses_build", title: "Build: Widget X Export" },
      { sessionID: "ses_review", title: "Review: Widget X Export" },
    ]);
    expect(deletes).toContain("ses_title");
    expect(state.steps[0]?.title).toBe("Widget X Export");
    expect(state.steps[1]?.title).toBe("Widget X Export");
  });

  test("resume seeds initialWorkDescription so an inherited-title step titles its fresh session", async () => {
    writeTwoStepConfig();
    const captured: Array<{ sessionID: string; title: string }> = [];
    const client = makeStubClient({
      buildSessionID: "ses_review_resumed",
      reviewSessionID: "ses_unused",
      titleSessionID: "ses_title",
      titleText: "should-not-be-generated",
      capturedUpdates: captured,
      capturedDeletes: [],
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });

    // Simulate a startup resume at the Review step: Build already finished in a
    // prior process and generated the iteration title, which the run-state
    // pointer recovered into initialWorkDescription.
    const result = await runIteration({
      state,
      iteration: 1,
      client,
      repoDir: scratch,
      configDir,
      startStepIndex: 1,
      resumedPriorSteps: true,
      initialWorkDescription: "Widget X export",
    });

    expect(result).toBe("complete");
    expect(captured).toContainEqual({ sessionID: "ses_review_resumed", title: "Review: Widget X export" });
    // No title session should have been created for an inherited title.
    expect(captured.every((c) => c.sessionID !== "ses_title")).toBe(true);
  });

  test("defaults title model to opencode small_model when none configured", async () => {
    writeTwoStepConfig();
    const models: Array<{ providerID: string; modelID: string } | undefined> = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: [],
      capturedDeletes: [],
      capturedTitleModels: models,
      smallModel: "openai/gpt-5.5-nano",
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    await runIteration({ state, iteration: 1, client, repoDir: scratch, configDir });

    expect(models).toContainEqual({ providerID: "openai", modelID: "gpt-5.5-nano" });
  });

  test("falls back to default model when small_model is unset", async () => {
    writeTwoStepConfig();
    const models: Array<{ providerID: string; modelID: string } | undefined> = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: [],
      capturedDeletes: [],
      capturedTitleModels: models,
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    await runIteration({ state, iteration: 1, client, repoDir: scratch, configDir });

    expect(models).toContainEqual(undefined);
  });

  function model(id: string, reasoning: boolean, cost: number): Record<string, unknown> {
    return { id, providerID: "anthropic", capabilities: { reasoning }, cost: { input: cost, output: cost }, status: "active" };
  }

  test("hybrid: prefers opencode's curated cheap model in the step's provider", async () => {
    writeTwoStepConfig();
    const models: Array<{ providerID: string; modelID: string } | undefined> = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: [],
      capturedDeletes: [],
      capturedTitleModels: models,
      stepProviderID: "anthropic",
      stepModelID: "claude-opus-4-8",
      providerList: {
        all: [
          {
            id: "anthropic",
            models: {
              "claude-opus-4-8": model("claude-opus-4-8", true, 15),
              "claude-haiku-4-5": model("claude-haiku-4-5", false, 1),
              "claude-3-5-haiku": model("claude-3-5-haiku", false, 0.5),
            },
          },
        ],
      },
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    await runIteration({ state, iteration: 1, client, repoDir: scratch, configDir });

    expect(models).toContainEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" });
  });

  test("hybrid: falls back to cheapest model when no curated match", async () => {
    writeTwoStepConfig();
    const models: Array<{ providerID: string; modelID: string } | undefined> = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: [],
      capturedDeletes: [],
      capturedTitleModels: models,
      stepProviderID: "anthropic",
      stepModelID: "big-reasoner",
      providerList: {
        all: [
          {
            id: "anthropic",
            models: {
              "big-reasoner": model("big-reasoner", true, 20),
              "mid-chat": model("mid-chat", false, 3),
              "cheap-chat": model("cheap-chat", false, 0.25),
            },
          },
        ],
      },
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    await runIteration({ state, iteration: 1, client, repoDir: scratch, configDir });

    expect(models).toContainEqual({ providerID: "anthropic", modelID: "cheap-chat" });
  });

  test("hybrid: matches a curated-name model even when it is reasoning-capable", async () => {
    writeTwoStepConfig();
    const models: Array<{ providerID: string; modelID: string } | undefined> = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: [],
      capturedDeletes: [],
      capturedTitleModels: models,
      stepProviderID: "anthropic",
      stepModelID: "claude-opus-4-8",
      providerList: {
        all: [
          {
            id: "anthropic",
            models: {
              "claude-haiku-4-5": model("claude-haiku-4-5", true, 1),
              "plain-chat": model("plain-chat", false, 2),
            },
          },
        ],
      },
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    await runIteration({ state, iteration: 1, client, repoDir: scratch, configDir });

    expect(models).toContainEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" });
    expect(models).not.toContainEqual({ providerID: "anthropic", modelID: "plain-chat" });
  });

  test("hybrid: takes the first priority-fragment match in provider order", async () => {
    writeTwoStepConfig();
    const models: Array<{ providerID: string; modelID: string } | undefined> = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: [],
      capturedDeletes: [],
      capturedTitleModels: models,
      stepProviderID: "anthropic",
      stepModelID: "claude-opus-4-8",
      providerList: {
        all: [
          {
            id: "anthropic",
            models: {
              "claude-haiku-4-5-20251001": model("claude-haiku-4-5-20251001", true, 1),
              "claude-haiku-4-5": model("claude-haiku-4-5", true, 1),
              "claude-3-5-haiku-latest": model("claude-3-5-haiku-latest", false, 0.8),
            },
          },
        ],
      },
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    await runIteration({ state, iteration: 1, client, repoDir: scratch, configDir });

    expect(models).toContainEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" });
  });

  test("hybrid: skips rolling latest aliases when resolving title models", async () => {
    writeTwoStepConfig();
    const models: Array<{ providerID: string; modelID: string } | undefined> = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: [],
      capturedDeletes: [],
      capturedTitleModels: models,
      stepProviderID: "anthropic",
      stepModelID: "claude-opus-4-8",
      providerList: {
        all: [
          {
            id: "anthropic",
            models: {
              "claude-haiku-4-5-20251001": { ...model("claude-haiku-4-5-20251001", true, 1), status: "deprecated" },
              "claude-3-5-haiku-latest": model("claude-3-5-haiku-latest", false, 0.1),
              "cheap-chat": model("cheap-chat", false, 0.25),
            },
          },
        ],
      },
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    await runIteration({ state, iteration: 1, client, repoDir: scratch, configDir });

    expect(models).toContainEqual({ providerID: "anthropic", modelID: "cheap-chat" });
    expect(models).not.toContainEqual({ providerID: "anthropic", modelID: "claude-3-5-haiku-latest" });
  });

  test("hybrid: falls back to a cheap reasoning model when the provider is reasoning-only", async () => {
    writeTwoStepConfig();
    const models: Array<{ providerID: string; modelID: string } | undefined> = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: [],
      capturedDeletes: [],
      capturedTitleModels: models,
      stepProviderID: "openai",
      stepModelID: "gpt-5.5",
      providerList: {
        all: [
          {
            id: "openai",
            models: {
              "gpt-5.5": { id: "gpt-5.5", providerID: "openai", capabilities: { reasoning: true }, cost: { input: 10, output: 10 }, status: "active" },
              "gpt-5-nano": { id: "gpt-5-nano", providerID: "openai", capabilities: { reasoning: true }, cost: { input: 0.1, output: 0.1 }, status: "active" },
            },
          },
        ],
      },
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    await runIteration({ state, iteration: 1, client, repoDir: scratch, configDir });

    expect(models).toContainEqual({ providerID: "openai", modelID: "gpt-5-nano" });
    expect(models).not.toContain(undefined);
  });

  test("hybrid: falls back to Anthropic provider metadata when only reasoning models are available", async () => {
    writeTwoStepConfig();
    const models: Array<{ providerID: string; modelID: string } | undefined> = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: [],
      capturedDeletes: [],
      capturedTitleModels: models,
      stepProviderID: "anthropic",
      stepModelID: "claude-opus-4-8",
      providerList: {
        all: [
          {
            id: "anthropic",
            models: {
              "claude-haiku-4-5-20251001": model("claude-haiku-4-5-20251001", true, 0.5),
              "claude-sonnet-4-5-20250929": model("claude-sonnet-4-5-20250929", true, 2),
              "claude-opus-4-8": model("claude-opus-4-8", true, 15),
            },
          },
        ],
      },
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    await runIteration({ state, iteration: 1, client, repoDir: scratch, configDir });

    expect(models).toContainEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" });
  });

  test("model error response deletes the title session and applies no title", async () => {
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
      titleError: { name: "APIError", data: { message: "adaptive thinking is not supported on this model", statusCode: 400 } },
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    const result = await runIteration({ state, iteration: 1, client, repoDir: scratch, configDir });

    expect(result).toBe("complete");
    expect(captured).toEqual([]);
    expect(deletes).toContain("ses_title");
    expect(state.steps[0]?.title).toBeUndefined();
  });

  test("non-trivial branch is injected into the title prompt", async () => {
    writeTwoStepConfig();
    const captured: Array<{ sessionID: string; title: string }> = [];
    const deletes: string[] = [];
    const prompts: string[] = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "US-057 guide frontmatter schema",
      capturedUpdates: captured,
      capturedDeletes: deletes,
      capturedTitlePrompts: prompts,
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    state.branch = "us-057-guide-frontmatter-schema";

    const result = await runIteration({
      state,
      iteration: 1,
      client,
      repoDir: scratch,
      configDir,
    });

    expect(result).toBe("complete");
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain("[branch: us-057-guide-frontmatter-schema]");
    expect(state.steps[0]?.title).toBe("US-057 Guide Frontmatter Schema");
  });

  test("trivial branch names (main/master/etc) are NOT injected", async () => {
    writeTwoStepConfig();
    const captured: Array<{ sessionID: string; title: string }> = [];
    const deletes: string[] = [];
    const prompts: string[] = [];
    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "Widget X export",
      capturedUpdates: captured,
      capturedDeletes: deletes,
      capturedTitlePrompts: prompts,
    });

    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    state.branch = "main";

    await runIteration({
      state,
      iteration: 1,
      client,
      repoDir: scratch,
      configDir,
    });

    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).not.toContain("[branch:");
  });

  test("title: branch applies a deterministic branch title when branch changes mid-step", async () => {
    writeFileSync(
      join(configDir, "looper.yaml"),
      [
        "steps:",
        "  build:",
        "    name: Build",
        "    agent: build",
        "    prompt: build.md",
        "    title: branch",
        "  review:",
        "    name: Review",
        "    agent: build",
        "    prompt: review.md",
        "",
      ].join("\n"),
    );

    const captured: Array<{ sessionID: string; title: string }> = [];
    const deletes: string[] = [];
    const prompts: string[] = [];
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Review"] });
    state.branch = "main";

    // Snapshots captured WHILE the build stream is still running — these are
    // the assertions that pin down the mid-step apply behavior (the bug fix):
    // by the time the streamPostHook returns, state.steps[0].title and the
    // opencode session.update for ses_build must already be observable.
    let midStepBuildTitle: string | undefined;
    let midStepCapturedCount = 0;

    const client = makeStubClient({
      buildSessionID: "ses_build",
      reviewSessionID: "ses_review",
      titleSessionID: "ses_title",
      titleText: "US-001 feature",
      capturedUpdates: captured,
      capturedDeletes: deletes,
      capturedTitlePrompts: prompts,
      streamPostHook: async () => {
        state.branch = "us-001-feature";
        await Bun.sleep(800);
        midStepBuildTitle = state.steps[0]?.title;
        midStepCapturedCount = captured.length;
      },
    });

    const result = await runIteration({
      state,
      iteration: 1,
      client,
      repoDir: scratch,
      configDir,
    });

    expect(result).toBe("complete");
    expect(prompts).toEqual([]);
    expect(deletes).not.toContain("ses_title");

    // Mid-step assertions: title applied to TUI state AND opencode BEFORE step end.
    expect(midStepBuildTitle).toBe("US-001 Feature");
    expect(midStepCapturedCount).toBeGreaterThan(0);
    expect(captured.slice(0, midStepCapturedCount)).toContainEqual({
      sessionID: "ses_build",
      title: "Build: US-001 Feature",
    });

    // End-of-iteration: Review inherited the description.
    expect(state.steps[1]?.title).toBe("US-001 Feature");
    expect(captured).toContainEqual({ sessionID: "ses_review", title: "Review: US-001 Feature" });
  });

  test("inherited title renames opencode session ~5s after first response, not at step end", async () => {
    writeTwoStepConfig();
    const prev = process.env["LOOPER_INHERITED_TITLE_DELAY_MS"];
    process.env["LOOPER_INHERITED_TITLE_DELAY_MS"] = "100";
    try {
      const captured: Array<{ sessionID: string; title: string }> = [];
      const deletes: string[] = [];
      let streamCount = 0;
      let reviewMidStreamCaptured: Array<{ sessionID: string; title: string }> = [];

      const client = makeStubClient({
        buildSessionID: "ses_build",
        reviewSessionID: "ses_review",
        titleSessionID: "ses_title",
        titleText: "Widget X export",
        capturedUpdates: captured,
        capturedDeletes: deletes,
        streamPostHook: async () => {
          streamCount += 1;
          if (streamCount === 2) {
            await Bun.sleep(300);
            reviewMidStreamCaptured = [...captured];
          }
        },
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
      expect(reviewMidStreamCaptured).toContainEqual({
        sessionID: "ses_review",
        title: "Review: Widget X Export",
      });
      expect(captured.filter((c) => c.sessionID === "ses_review")).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env["LOOPER_INHERITED_TITLE_DELAY_MS"];
      else process.env["LOOPER_INHERITED_TITLE_DELAY_MS"] = prev;
    }
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

describe("inherited title across retry/timeout", () => {
  let scratch: string;
  let configDir: string;
  const prevDelay = process.env["LOOPER_INHERITED_TITLE_DELAY_MS"];

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "looper-title-retry-"));
    configDir = join(scratch, ".local", "looper");
    mkdirSync(configDir, { recursive: true });
    initStatePaths({ configDir });
    writeFileSync(join(configDir, "review.md"), "review the build\n");
    // Single step with NO own title config: it inherits via initialWorkDescription.
    writeFileSync(
      join(configDir, "looper.yaml"),
      "steps:\n  review:\n    name: Review\n    agent: build\n    prompt: review.md\n    timeout: 1s\n",
    );
    process.env["LOOPER_INHERITED_TITLE_DELAY_MS"] = "20";
  });

  afterEach(() => {
    if (prevDelay === undefined) delete process.env["LOOPER_INHERITED_TITLE_DELAY_MS"];
    else process.env["LOOPER_INHERITED_TITLE_DELAY_MS"] = prevDelay;
    rmSync(scratch, { recursive: true, force: true });
  });

  test("re-applies the inherited title to the new session after a timeout restart", async () => {
    const updates: Array<{ sessionID: string; title: string }> = [];
    const sessionIDs = ["ses_old", "ses_new"];
    const created: string[] = [];

    async function* oldStream(signal: AbortSignal): AsyncGenerator<unknown> {
      yield { type: "message.updated", properties: { info: { id: "msg1", role: "assistant" } } };
      yield { type: "message.part.updated", properties: { part: { id: "p1", messageID: "msg1", type: "text", text: "working" } } };
      await waitForAbort(signal);
    }
    async function* emptyStream(signal: AbortSignal): AsyncGenerator<never> {
      await waitForAbort(signal);
    }

    const client = {
      config: { get: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [] } }) },
      event: {
        subscribe: async (_p: unknown, opts: { signal: AbortSignal }) => ({
          stream: created.length <= 1 ? oldStream(opts.signal) : emptyStream(opts.signal),
        }),
      },
      session: {
        create: async () => {
          const id = sessionIDs[created.length];
          if (id === undefined) throw new Error("unexpected extra session.create");
          created.push(id);
          return { data: { id } };
        },
        prompt: async (params: { sessionID: string }, opts: { signal: AbortSignal }) => {
          if (params.sessionID === "ses_old") {
            await waitForAbort(opts.signal);
            throw abortError();
          }
          writeIdleContinuationRecord(scratch, params.sessionID);
          return { data: {} };
        },
        status: async () => ({ data: { ses_old: { type: "idle" }, ses_new: { type: "idle" } } }),
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
        update: async ({ sessionID, title }: { sessionID: string; title: string }) => {
          updates.push({ sessionID, title });
          return {};
        },
        abort: async () => ({}),
        delete: async () => ({}),
      },
    } as unknown as OpencodeClient;

    const state = createLoopState({ maxIterations: 1, stepNames: ["Review"] });
    const result = await runIteration({
      state,
      iteration: 1,
      client,
      repoDir: scratch,
      configDir,
      initialWorkDescription: "Widget X export",
    });

    expect(result).toBe("complete");
    expect(created).toEqual(["ses_old", "ses_new"]);
    // The abandoned first session may have been titled, but the FINAL (restart)
    // session must end up with the inherited title.
    expect(updates).toContainEqual({ sessionID: "ses_new", title: "Review: Widget X export" });
  }, 15000);
});
