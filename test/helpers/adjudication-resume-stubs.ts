import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import type { LoopState } from "../../src/lib/state.ts";
import { initStatePaths } from "../../src/lib/state-files.ts";

export type Scratch = { readonly repoDir: string; readonly configDir: string; readonly prdDir: string };

const scratchDirs: string[] = [];

export function setup(): Scratch {
  const repoDir = join(import.meta.dir, ".tmp", `adjudication-resume-${crypto.randomUUID()}`);
  const configDir = join(repoDir, ".looper");
  const prdDir = join(repoDir, "spec");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(prdDir, { recursive: true });
  initStatePaths({ configDir });
  writeFileSync(join(configDir, "step1.md"), "step1 prompt\n");
  writeFileSync(join(configDir, "adjudicate.md"), "resolve the PRD conflict\n");
  writeFileSync(join(configDir, "looper.yaml"), "steps:\n  step1:\n    prompt: step1.md\nadjudicate:\n  prompt: adjudicate.md\n");
  writeFileSync(join(prdDir, "prd.json"), JSON.stringify({ userStories: [{ id: "story-1", passes: true }] }));
  scratchDirs.push(repoDir);
  return { repoDir, configDir, prdDir };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function writeIdleContinuation(repoDir: string, sessionID: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  const updatedAt = new Date().toISOString();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionID}.json`), JSON.stringify({ sessionID, updatedAt, sources: { "background-task": { state: "idle", updatedAt } } }));
}

export function backgroundResumptionClient(repoDir: string): {
  readonly client: OpencodeClient;
  readonly backgroundResumptionReached: () => boolean;
} {
  let messagesCalls = 0;
  let statusCalls = 0;
  let reattachReady = false;
  const writeContinuation = (state: "active" | "idle"): void => {
    const dir = join(repoDir, ".omo", "run-continuation");
    const updatedAt = new Date().toISOString();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ses_adjudicate.json"), JSON.stringify({ sessionID: "ses_adjudicate", updatedAt, sources: { "background-task": { state, updatedAt } } }));
  };
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_adjudicate" } }),
      prompt: async () => {
        writeContinuation("active");
        return { data: {} };
      },
      status: async () => {
        statusCalls += 1;
        if (messagesCalls === 1 && statusCalls >= 2 && !reattachReady) writeContinuation("idle");
        return { data: { ses_adjudicate: { type: reattachReady ? "idle" : "busy" } } };
      },
      messages: async () => {
        messagesCalls += 1;
        if (messagesCalls === 1) return { data: [] };
        reattachReady = true;
        return { data: [
          { info: { id: "msg_continuation", role: "user", time: { created: Date.now() } }, parts: [] },
          { info: { id: "asst_done", role: "assistant", parentID: "msg_continuation", time: { created: Date.now(), completed: Date.now() }, tokens: { output: 1 } }, parts: [] },
        ] };
      },
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> {
          await waitForAbort(options.signal);
        })(),
      }),
    },
  } as unknown as OpencodeClient;
  return { client, backgroundResumptionReached: () => messagesCalls > 1 };
}

export function skippedRouteClient(input: {
  readonly repoDir: string;
  readonly getState: () => LoopState | undefined;
  readonly writeMarker: () => void;
  readonly observeRoute: () => void;
}): OpencodeClient {
  let promptOrdinal = 0;
  let sessionOrdinal = 0;
  const client = {
    session: {
      create: async () => {
        sessionOrdinal += 1;
        return { data: { id: `ses_${sessionOrdinal}` } };
      },
      prompt: async (params: { sessionID: string }, _options: { signal: AbortSignal }) => {
        promptOrdinal += 1;
        if (promptOrdinal === 1) {
          input.writeMarker();
          const state = input.getState();
          if (state !== undefined) state.skipRequested = true;
          await Bun.sleep(200);
        } else {
          input.observeRoute();
        }
        writeIdleContinuation(input.repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { ses_1: { type: "idle" }, ses_2: { type: "idle" } } }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> {
          await waitForAbort(options.signal);
        })(),
      }),
    },
  } as unknown as OpencodeClient;
  return client;
}

export function adjudicatorErrorClient(input: {
  readonly state: LoopState;
  readonly prompts: string[];
  readonly phase: "before-dispatch" | "sync-prompt-throw" | "after-dispatch" | "success";
  readonly repoDir: string;
  readonly prdDir?: string;
}): OpencodeClient {
  const client = {
    session: {
      create: async () => {
        if (input.phase === "before-dispatch") {
          input.state.quitting = true;
          throw new Error("create failed before dispatch");
        }
        return { data: { id: "ses_adjudication_boundary" } };
      },
      prompt: (params: { sessionID: string; parts: { text: string }[] }) => {
        if (input.phase === "sync-prompt-throw") {
          input.state.quitting = true;
          throw new Error("prompt threw before returning a promise");
        }
        input.prompts.push(params.parts.map((part) => part.text).join("\n"));
        writeIdleContinuation(input.repoDir, params.sessionID);
        if (input.phase === "after-dispatch" && input.prdDir !== undefined) {
          writeFileSync(join(input.prdDir, "prd.json"), JSON.stringify({ userStories: [{ id: "story-1", passes: false }] }));
        }
        return Promise.resolve({ data: {} });
      },
      status: async () => ({ data: { ses_adjudication_boundary: { type: "idle" } } }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> {
          await waitForAbort(options.signal);
        })(),
      }),
    },
    vcs: { status: async () => ({ data: [] }) },
  } as unknown as OpencodeClient;
  return client;
}

export function unconfirmedTerminalClient(input: {
  readonly state: LoopState;
  readonly writeMarker: () => void;
  readonly adjudicationPrompts: string[];
  readonly abortedSessions: string[];
}): OpencodeClient {
  let promptOrdinal = 0;
  const client = {
    session: {
      create: async () => ({ data: { id: `ses_${promptOrdinal + 1}` } }),
      prompt: async (params: { parts: { text: string }[] }) => {
        promptOrdinal += 1;
        if (promptOrdinal === 1) {
          input.writeMarker();
          throw new Error("normal step transport failed");
        }
        input.adjudicationPrompts.push(params.parts.map((part) => part.text).join("\n"));
        input.state.quitting = true;
        throw new Error("adjudication must not start");
      },
      status: async () => ({ error: { name: "Unavailable", data: { message: "status unavailable" } } }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async (params: { sessionID: string }) => {
        input.abortedSessions.push(params.sessionID);
        return { error: { name: "Unavailable", data: { message: "abort unconfirmed" } } };
      },
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> {
          await waitForAbort(options.signal);
        })(),
      }),
    },
    vcs: { status: async () => ({ data: [] }) },
  } as unknown as OpencodeClient;
  return client;
}

export function cleanupAdjudicationResumeScratch(): void {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
