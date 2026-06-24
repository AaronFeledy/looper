import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { runIteration, type ResumeSession } from "../src/lib/orchestrator.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";

type Ops = string[];

function abortableStream(signal: AbortSignal): AsyncGenerator<never> {
  return (async function* (): AsyncGenerator<never> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  })();
}

function writeIdleContinuation(repoDir: string, sessionID: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${sessionID}.json`),
    JSON.stringify({ sessionID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
  );
}

function setupScratch(): { repoDir: string; configDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-resume-"));
  const configDir = join(repoDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  writeFileSync(join(configDir, "build.md"), "build from scratch\n");
  writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    timeout: 1h\n");
  return { repoDir, configDir };
}

describe("resume gate (reattach if active, otherwise restart)", () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  test("idle prior session restarts fresh: no reattach, new session, no abort", async () => {
    const { repoDir, configDir } = setupScratch();
    scratch = repoDir;
    const state: LoopState = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const ops: Ops = [];
    const created: string[] = [];

    const client = {
      session: {
        create: async () => {
          const id = "ses_new";
          created.push(id);
          ops.push(`create:${id}`);
          return { data: { id } };
        },
        prompt: async (params: { sessionID: string }) => {
          ops.push(`prompt:${params.sessionID}`);
          writeIdleContinuation(repoDir, params.sessionID);
          return { data: {} };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          ops.push(`abort:${sessionID}`);
          return { data: {} };
        },
        status: async () => ({ data: { ses_old: { type: "idle" }, ses_new: { type: "idle" } } }),
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
      },
      event: {
        subscribe: async (_p: unknown, options: { signal: AbortSignal }) => ({ stream: abortableStream(options.signal) }),
      },
    } as unknown as OpencodeClient;

    const resume: ResumeSession = { sessionID: "ses_old", messageID: "msg_old", stepName: "Build" };
    const result = await runIteration({ state, iteration: 4, client, repoDir, configDir, resume });

    expect(result).toBe("complete");
    expect(created).toEqual(["ses_new"]);
    expect(ops).not.toContain("abort:ses_old");
    expect(ops[0]).toBe("create:ses_new");
  });

  test("pending prior session with no messageID is stopped before a fresh restart", async () => {
    const { repoDir, configDir } = setupScratch();
    scratch = repoDir;
    const state: LoopState = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const ops: Ops = [];
    const created: string[] = [];
    let oldAborted = false;

    const client = {
      session: {
        create: async () => {
          const id = "ses_new";
          created.push(id);
          ops.push(`create:${id}`);
          return { data: { id } };
        },
        prompt: async (params: { sessionID: string }) => {
          ops.push(`prompt:${params.sessionID}`);
          writeIdleContinuation(repoDir, params.sessionID);
          return { data: {} };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          ops.push(`abort:${sessionID}`);
          if (sessionID === "ses_old") oldAborted = true;
          return { data: {} };
        },
        status: async () => ({
          data: {
            ses_old: { type: oldAborted ? "idle" : "busy" },
            ses_new: { type: "idle" },
          },
        }),
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
      },
      event: {
        subscribe: async (_p: unknown, options: { signal: AbortSignal }) => ({ stream: abortableStream(options.signal) }),
      },
    } as unknown as OpencodeClient;

    const resume: ResumeSession = { sessionID: "ses_old", stepName: "Build" };
    const result = await runIteration({ state, iteration: 2, client, repoDir, configDir, resume });

    expect(result).toBe("complete");
    expect(created).toEqual(["ses_new"]);
    const abortIdx = ops.indexOf("abort:ses_old");
    const createIdx = ops.indexOf("create:ses_new");
    expect(abortIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(abortIdx);
  });

  test("pending prior session with a messageID reattaches instead of creating a new session", async () => {
    const { repoDir, configDir } = setupScratch();
    scratch = repoDir;
    const state: LoopState = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const ops: Ops = [];
    const created: string[] = [];
    let statusReads = 0;

    const client = {
      session: {
        create: async () => {
          created.push("ses_new");
          ops.push("create:ses_new");
          return { data: { id: "ses_new" } };
        },
        prompt: async (params: { sessionID: string }) => {
          ops.push(`prompt:${params.sessionID}`);
          return { data: {} };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          ops.push(`abort:${sessionID}`);
          return { data: {} };
        },
        status: async () => {
          statusReads += 1;
          // First read (resume gate) reports busy so we reattach; subsequent
          // reattach polls report idle so the reattach loop completes.
          return { data: { ses_old: { type: statusReads <= 1 ? "busy" : "idle" } } };
        },
        messages: async () => ({
          data: [
            { info: { id: "msg_old", role: "user" }, parts: [] },
            {
              info: { id: "asst", role: "assistant", parentID: "msg_old", time: { created: 1, completed: 2 }, tokens: { output: 1 } },
              parts: [{ id: "part_text", messageID: "asst", sessionID: "ses_old", type: "text", text: "done" }],
            },
          ],
        }),
        children: async () => ({ data: [] }),
      },
      event: {
        subscribe: async (_p: unknown, options: { signal: AbortSignal }) => ({ stream: abortableStream(options.signal) }),
      },
    } as unknown as OpencodeClient;

    writeIdleContinuation(repoDir, "ses_old");
    const resume: ResumeSession = { sessionID: "ses_old", messageID: "msg_old", stepName: "Build" };
    const result = await runIteration({ state, iteration: 5, client, repoDir, configDir, resume });

    expect(result).toBe("complete");
    expect(created).toEqual([]);
    expect(ops.some((op) => op.startsWith("prompt"))).toBe(false);
    expect(state.steps.at(-1)!.sessionID).toBe("ses_old");
  });

  test("reattach re-persists the live session ids dropped by onStepBegin", async () => {
    const { repoDir, configDir } = setupScratch();
    scratch = repoDir;
    const state: LoopState = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    let statusReads = 0;
    const sessionCalls: Array<{ iteration: number; index: number; stepName: string; sessionID: string; messageID: string }> = [];

    const client = {
      session: {
        create: async () => ({ data: { id: "ses_new" } }),
        prompt: async () => ({ data: {} }),
        abort: async () => ({ data: {} }),
        status: async () => {
          statusReads += 1;
          return { data: { ses_old: { type: statusReads <= 1 ? "busy" : "idle" } } };
        },
        messages: async () => ({
          data: [
            { info: { id: "msg_old", role: "user" }, parts: [] },
            {
              info: { id: "asst", role: "assistant", parentID: "msg_old", time: { created: 1, completed: 2 }, tokens: { output: 1 } },
              parts: [{ id: "part_text", messageID: "asst", sessionID: "ses_old", type: "text", text: "done" }],
            },
          ],
        }),
        children: async () => ({ data: [] }),
      },
      event: {
        subscribe: async (_p: unknown, options: { signal: AbortSignal }) => ({ stream: abortableStream(options.signal) }),
      },
    } as unknown as OpencodeClient;

    writeIdleContinuation(repoDir, "ses_old");
    const resume: ResumeSession = { sessionID: "ses_old", messageID: "msg_old", stepName: "Build" };
    const result = await runIteration({
      state,
      iteration: 5,
      client,
      repoDir,
      configDir,
      resume,
      hooks: {
        onStepSession: (info) => sessionCalls.push(info),
      },
    });

    expect(result).toBe("complete");
    expect(sessionCalls).toContainEqual({ iteration: 5, index: 0, stepName: "Build", sessionID: "ses_old", messageID: "msg_old" });
  });
});
