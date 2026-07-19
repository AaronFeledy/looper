import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { parseArgs, resolveAttachUrl } from "../src/lib/args.ts";
import { loadRuntimeConfig } from "../src/lib/config.ts";
import { runIteration, StepFailureError } from "../src/lib/orchestrator.ts";
import { reattachOpenCodeStep, runOpenCodeStep, type Step } from "../src/lib/runner.ts";
import { startOrAttachServer } from "../src/lib/sdk-server.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths } from "../src/lib/state-files.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const LOOPER_BIN = join(REPO_ROOT, "bin", "looper");
const MAIN_ENTRY = join(REPO_ROOT, "src", "main.ts");
const TMP_ROOT = join(import.meta.dir, ".tmp");
const SCRATCH = join(TMP_ROOT, `e2e-${process.pid}-${Date.now()}`);
const CONFIG_DIR = join(SCRATCH, ".local", "looper");

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode";
const MODEL = process.env.LOOPER_E2E_MODEL ?? "openai/gpt-5.5";
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = spawn({ cmd: ["which", cmd], stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
});

afterAll(() => {
  if (process.env.LOOPER_E2E_KEEP) return;
  rmSync(SCRATCH, { recursive: true, force: true });
});

const itHasOpencode = await commandExists(OPENCODE_BIN);

test.skipIf(!itHasOpencode)(
  "runs two cheap steps against a real OpenCode server and stops cleanly via .looper-stop",
  async () => {
    const markerPromptPath = join(CONFIG_DIR, "marker.md");
    writeFileSync(
      markerPromptPath,
      [
        "Create one file in the current working directory using any available file-writing tool",
        "(such as `apply_patch`, `write`, or the equivalent):",
        "  - Path: `marker.txt`",
        "  - Exact content: `hello` (no trailing newline)",
        "Then stop.",
        "",
      ].join("\n"),
    );

    const stopPromptPath = join(CONFIG_DIR, "stop.md");
    writeFileSync(
      stopPromptPath,
      [
        "Create two files in the current working directory using any available file-writing tool",
        "(such as `apply_patch`, `write`, or the equivalent):",
        "  1. Path: `done.txt`   Exact content: `ok` (no trailing newline)",
        "  2. Path: `.local/looper/.looper-stop`   Exact content: `e2e done` (no trailing newline)",
        "Then stop.",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(CONFIG_DIR, "looper.yaml"),
      [
        "steps:",
        "  marker:",
        "    name: Marker",
        "    agent: build",
        `    model: ${MODEL}`,
        "    variant: low",
        `    prompt: ${markerPromptPath}`,
        "  stop:",
        "    name: Stop",
        "    agent: build",
        `    model: ${MODEL}`,
        "    variant: low",
        `    prompt: ${stopPromptPath}`,
        "",
      ].join("\n"),
    );

    // max iterations = 2 so the 2nd iteration short-circuits on the stop file
    // written by step 2 and the process exits 0 instead of "max iterations reached".
    const proc = spawn({
      cmd: ["bun", MAIN_ENTRY, "--start", "2"],
      cwd: SCRATCH,
      env: { ...process.env, OPENCODE_BIN, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const drainStdout = (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutChunks.push(decoder.decode(value));
      }
    })();
    const drainStderr = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(decoder.decode(value));
      }
    })();

    const exitCode = await proc.exited;
    await Promise.all([drainStdout, drainStderr]);

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    try {
      expect(exitCode).toBe(0);

      const marker = join(SCRATCH, "marker.txt");
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8").trim()).toBe("hello");

      const done = join(SCRATCH, "done.txt");
      expect(existsSync(done)).toBe(true);
      expect(readFileSync(done, "utf8").trim()).toBe("ok");

      const stopFile = join(CONFIG_DIR, ".looper-stop");
      expect(existsSync(stopFile)).toBe(true);
      expect(readFileSync(stopFile, "utf8")).toContain("e2e done");

      expect(stdout).toContain("Marker");
      expect(stdout).toContain("Stop");
    } catch (error) {
      console.error(`looper exited with code ${exitCode}`);
      console.error("--- stdout ---\n" + stdout);
      console.error("--- stderr ---\n" + stderr);
      throw error;
    }
  },
  TEST_TIMEOUT_MS,
);

test("bin wrapper resolves through symlinks and prints help", async () => {
  const proc = spawn({
    cmd: [LOOPER_BIN, "--help"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);
  expect(out).toContain("Looper - iterative OpenCode step runner");
  expect(out).toContain("--config-dir");
  expect(out).toContain(".looper");
  expect(out).toContain("looper.yml");
});

test("fails fast with exit 2 when no config is present, and auto-creates the config dir", async () => {
  const emptyDir = join(SCRATCH, "empty");
  mkdirSync(emptyDir, { recursive: true });
  const proc = spawn({
    cmd: ["bun", MAIN_ENTRY, "--start"],
    cwd: emptyDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  expect(exitCode).toBe(2);
  expect(err).toContain("missing looper.yml");
  expect(existsSync(join(emptyDir, ".looper"))).toBe(true);
});

test("--config-dir overrides config-dir detection and is auto-created", async () => {
  const repoDir = join(SCRATCH, "config-dir-flag");
  const customDir = join(repoDir, "custom-looper");
  mkdirSync(repoDir, { recursive: true });
  const proc = spawn({
    cmd: ["bun", MAIN_ENTRY, "--config-dir", customDir, "--start"],
    cwd: repoDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  expect(exitCode).toBe(2);
  expect(err).toContain(customDir);
  expect(existsSync(customDir)).toBe(true);
  expect(existsSync(join(repoDir, ".looper"))).toBe(false);
});

test("loads an existing OpenCode server URL from looper.yaml", () => {
  const configDir = join(SCRATCH, "config-server-url");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "looper.yaml"),
    [
      "opencode:",
      "  serverUrl: http://127.0.0.1:4096",
      "steps:",
      "  noop:",
      "    prompt: noop.md",
      "",
    ].join("\n"),
  );

  expect(loadRuntimeConfig(configDir).opencodeServerUrl).toBe("http://127.0.0.1:4096");
});

test("parses opencode.title agent/model/variant overrides", () => {
  const configDir = join(SCRATCH, "config-title-override");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "looper.yaml"),
    [
      "opencode:",
      "  title:",
      "    agent: build",
      "    model: openai/gpt-5.5-nano",
      "    variant: low",
      "steps:",
      "  noop:",
      "    prompt: noop.md",
      "",
    ].join("\n"),
  );

  expect(loadRuntimeConfig(configDir).title).toEqual({
    agent: "build",
    model: "openai/gpt-5.5-nano",
    variant: "low",
  });
});

test("omits opencode.title from runtime config when no fields are set", () => {
  const configDir = join(SCRATCH, "config-title-empty");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "looper.yaml"),
    [
      "opencode:",
      "  title: {}",
      "steps:",
      "  noop:",
      "    prompt: noop.md",
      "",
    ].join("\n"),
  );

  expect(loadRuntimeConfig(configDir).title).toBeUndefined();
});

test("rejects non-string opencode.title.model", () => {
  const configDir = join(SCRATCH, "config-title-bad");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "looper.yaml"),
    [
      "opencode:",
      "  title:",
      "    model: 123",
      "steps:",
      "  noop:",
      "    prompt: noop.md",
      "",
    ].join("\n"),
  );

  expect(() => loadRuntimeConfig(configDir)).toThrow(/opencode\.title\.model must be a string/);
});

test("parses recovery snapshot policy", () => {
  const configDir = join(SCRATCH, "config-recovery-snapshots");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "looper.yaml"),
    [
      "recovery:",
      "  snapshots: before-retry-and-skip",
      "steps:",
      "  noop:",
      "    prompt: noop.md",
      "",
    ].join("\n"),
  );

  expect(loadRuntimeConfig(configDir).recovery.snapshots).toBe("before-retry-and-skip");
});

test("rejects invalid recovery snapshot policy", () => {
  const configDir = join(SCRATCH, "config-recovery-snapshots-bad");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "looper.yaml"),
    [
      "recovery:",
      "  snapshots: always",
      "steps:",
      "  noop:",
      "    prompt: noop.md",
      "",
    ].join("\n"),
  );

  expect(() => loadRuntimeConfig(configDir)).toThrow(/recovery\.snapshots must be false, "before-retry", or "before-retry-and-skip"/);
});

test("resolves attach URLs with CLI taking precedence over looper.yaml", () => {
  expect(resolveAttachUrl(parseArgs([]), "http://127.0.0.1:4096", "http://default.local")).toBe("http://127.0.0.1:4096");
  expect(resolveAttachUrl(parseArgs(["--attach=http://127.0.0.1:5000"]), "http://127.0.0.1:4096", "http://default.local")).toBe(
    "http://127.0.0.1:5000",
  );
  expect(resolveAttachUrl(parseArgs(["--attach"]), undefined, "http://default.local")).toBe("http://default.local");
  expect(resolveAttachUrl(parseArgs([]), undefined, "http://default.local")).toBeUndefined();
});

test("parses --config-dir in both = and space forms", () => {
  expect(parseArgs([]).configDir).toBeUndefined();
  expect(parseArgs(["--config-dir=/tmp/looper-cfg"]).configDir).toBe("/tmp/looper-cfg");
  expect(parseArgs(["--config-dir", "/tmp/looper-cfg"]).configDir).toBe("/tmp/looper-cfg");
  expect(() => parseArgs(["--config-dir"])).toThrow(/--config-dir requires a path/);
  expect(() => parseArgs(["--config-dir", ""])).toThrow(/--config-dir requires a path/);
  expect(() => parseArgs(["--config-dir="])).toThrow(/config dir cannot be empty/);
});

test("startOrAttachServer returns an attached handle without spawning opencode", async () => {
  const server = await startOrAttachServer({ opencodeBin: "definitely-not-opencode", attachUrl: "http://127.0.0.1:4096" });
  expect(server.url).toBe("http://127.0.0.1:4096");
  await server.close();
});

test("session error events fail the current step", async () => {
  async function* stream() {
    yield {
      type: "session.error",
      properties: { sessionID: "ses_error", error: { message: "provider rejected request" } },
    };
  }

  const client = {
    event: {
      subscribe: async () => ({ stream: stream() }),
    },
    session: {
      abort: async () => ({}),
      create: async () => ({ data: { id: "ses_error" } }),
      prompt: async () => ({}),
    },
  } as unknown as OpencodeClient;
  const state = createLoopState({ maxIterations: 1, stepNames: ["Sync"] });
  const step: Step = { name: "Sync", agent: "build", variant: "", model: "", prompt: "prompt.md" };

  const result = await runOpenCodeStep({
    state,
    stepIndex: 0,
    prompt: "run",
    client,
    repoDir: SCRATCH,
    step,
  });

  expect(result.status).toBe("failed");
  expect(result.errorMessage).toContain("provider rejected request");
  expect(state.steps[0]?.status).toBe("failed");
});

test("runIteration retries session errors twice before surfacing terminal failure", async () => {

  const retryDir = join(SCRATCH, "session-error-retries");
  const configDir = join(retryDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  writeFileSync(join(configDir, "prompt.md"), "trigger failure\n");
  writeFileSync(
    join(configDir, "looper.yaml"),
    [
      "steps:",
      "  sync:",
      "    name: Sync",
      "    agent: build",
      "    model: openai/gpt-5.5",
      "    variant: low",
      "    prompt: prompt.md",
      "",
    ].join("\n"),
  );

  let promptCount = 0;
  async function* stream() {
    yield {
      type: "session.error",
      properties: { sessionID: "ses_retry", error: { message: `provider failure ${promptCount}` } },
    };
  }

  const client = {
    event: {
      subscribe: async () => ({ stream: stream() }),
    },
    session: {
      abort: async () => ({}),
      children: async () => ({ data: [] }),
      create: async () => ({ data: { id: "ses_retry" } }),
      messages: async () => ({ data: [] }),
      prompt: async () => {
        promptCount += 1;
        return {};
      },
      status: async () => ({ data: {} }),
    },
  } as unknown as OpencodeClient;
  const state = createLoopState({ maxIterations: 1, stepNames: ["Sync"] });

  let failed: unknown;
  try {
    await runIteration({
      state,
      iteration: 1,
      client,
      repoDir: retryDir,
      configDir,
    });
  } catch (error) {
    failed = error;
  }
  expect(failed).toBeInstanceOf(StepFailureError);

  expect(promptCount).toBe(3);
  expect(state.steps.map((step) => step.status)).toEqual(["failed", "failed", "failed"]);
  const outputLines = state.steps.flatMap((step) => step.outputLines);
  expect(outputLines.some((line) => line.includes("waiting") && line.includes("before retry (attempt 1/2)"))).toBe(true);
  expect(outputLines.some((line) => line.includes("retrying now (attempt 1/2)"))).toBe(true);
  expect(outputLines.some((line) => line.includes("waiting") && line.includes("before retry (attempt 2/2)"))).toBe(true);
  expect(outputLines.some((line) => line.includes("retrying now (attempt 2/2)"))).toBe(true);
  expect(outputLines.some((line) => line.includes("not retrying: retry limit reached (2)"))).toBe(true);
}, 15000);

test("reattach honors an older session-scoped active continuation record", async () => {
  const repoDir = join(SCRATCH, "reattach-old-continuation");
  const stateDir = join(repoDir, ".local", "looper");
  const continuationDir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(continuationDir, { recursive: true });
  initStatePaths({ configDir: stateDir });

  const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    join(continuationDir, "ses_old.json"),
    JSON.stringify(
      {
        sessionID: "ses_old",
        updatedAt: oldTimestamp,
        sources: {
          "background-task": {
            state: "active",
            reason: "review",
            updatedAt: oldTimestamp,
          },
        },
      },
      null,
      2,
    ),
  );

  const client = {
    event: {
      subscribe: async () => ({ stream: new ReadableStream() }),
    },
    session: {
      abort: async () => ({}),
      status: async () => ({ data: { ses_old: { type: "idle" } } }),
      messages: async () => ({
        data: [
          {
            info: {
              role: "assistant",
              parentID: "msg_old",
              tokens: { output: 1 },
              time: { completed: Date.now() },
            },
            parts: [{ id: "prt_old", messageID: "msg_old", type: "text", text: "done" }],
          },
        ],
      }),
    },
  } as unknown as OpencodeClient;
  const state = createLoopState({ maxIterations: 1, stepNames: ["Review"] });
  const step: Step = { name: "Review", agent: "build", variant: "", model: "", prompt: "prompt.md" };

  const result = await reattachOpenCodeStep({
    state,
    stepIndex: 0,
    client,
    repoDir,
    step,
    sessionID: "ses_old",
    outcomeMessageID: "msg_old",
  });

  expect(result.status).toBe("waiting");
  expect(state.steps[0]?.status).toBe("waiting");
});

test("session-scoped continuation lookup rejects path traversal session IDs", async () => {
  const repoDir = join(SCRATCH, "reattach-traversal-continuation");
  const stateDir = join(repoDir, ".local", "looper");
  const continuationDir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(continuationDir, { recursive: true });
  initStatePaths({ configDir: stateDir });

  const now = new Date().toISOString();
  writeFileSync(
    join(repoDir, ".omo", "secret.json"),
    JSON.stringify(
      {
        sessionID: "../secret",
        updatedAt: now,
        sources: {
          "background-task": {
            state: "active",
            reason: "should-not-read",
            updatedAt: now,
          },
        },
      },
      null,
      2,
    ),
  );

  const client = {
    event: {
      subscribe: async () => ({ stream: new ReadableStream() }),
    },
    session: {
      abort: async () => ({}),
      status: async () => ({ data: { "../secret": { type: "idle" } } }),
      messages: async () => ({
        data: [
          {
            info: {
              role: "assistant",
              parentID: "msg_traversal",
              tokens: { output: 1 },
              time: { completed: Date.now() },
            },
            parts: [{ id: "prt_traversal", messageID: "msg_traversal", type: "text", text: "done" }],
          },
        ],
      }),
    },
  } as unknown as OpencodeClient;
  const state = createLoopState({ maxIterations: 1, stepNames: ["Review"] });
  const step: Step = { name: "Review", agent: "build", variant: "", model: "", prompt: "prompt.md" };

  const result = await reattachOpenCodeStep({
    state,
    stepIndex: 0,
    client,
    repoDir,
    step,
    sessionID: "../secret",
    outcomeMessageID: "msg_traversal",
  });

  expect(result.status).toBe("done");
  expect(state.steps[0]?.status).toBe("done");
});
