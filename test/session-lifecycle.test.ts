import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { runIteration } from "../src/lib/orchestrator.ts";
import { sessionPendingState, stopServerSession, waitForSessionHealth } from "../src/lib/runner.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";

type StatusType = "idle" | "busy" | "retry";

function statusClient(statuses: Array<StatusType | "error" | "throw">, opts?: { abortThrows?: boolean }): {
  client: OpencodeClient;
  aborts: string[];
  statusCalls: number;
} {
  const aborts: string[] = [];
  const counters = { statusCalls: 0 };
  const client = {
    session: {
      abort: async ({ sessionID }: { sessionID: string }) => {
        aborts.push(sessionID);
        if (opts?.abortThrows) throw new Error("abort boom");
        return { data: {} };
      },
      status: async () => {
        const idx = Math.min(counters.statusCalls, statuses.length - 1);
        counters.statusCalls += 1;
        const t = statuses[idx];
        if (t === "throw") throw new Error("status boom");
        if (t === "error") return { error: { message: "status unavailable" } };
        if (t === "retry") return { data: { sid: { type: "retry", attempt: 1, message: "x", next: 0 } } };
        return { data: { sid: { type: t } } };
      },
    },
  } as unknown as OpencodeClient;
  return {
    client,
    aborts,
    get statusCalls() {
      return counters.statusCalls;
    },
  };
}

describe("stopServerSession", () => {
  test("returns true once the session is confirmed idle and aborts it", async () => {
    const stub = statusClient(["busy", "idle"]);
    const confirmed = await stopServerSession({ client: stub.client, repoDir: "/x", sessionID: "sid", timeoutMs: 2000 });
    expect(confirmed).toBe(true);
    expect(stub.aborts).toEqual(["sid"]);
  });

  test("returns false when the session stays busy past the timeout", async () => {
    const stub = statusClient(["busy"]);
    const confirmed = await stopServerSession({ client: stub.client, repoDir: "/x", sessionID: "sid", timeoutMs: 300 });
    expect(confirmed).toBe(false);
    expect(stub.aborts).toEqual(["sid"]);
  });

  test("does NOT treat a status error as stopped (stays unconfirmed)", async () => {
    const stub = statusClient(["error"]);
    const confirmed = await stopServerSession({ client: stub.client, repoDir: "/x", sessionID: "sid", timeoutMs: 300 });
    expect(confirmed).toBe(false);
  });

  test("does NOT treat a thrown status as stopped (stays unconfirmed)", async () => {
    const stub = statusClient(["throw"]);
    const confirmed = await stopServerSession({ client: stub.client, repoDir: "/x", sessionID: "sid", timeoutMs: 300 });
    expect(confirmed).toBe(false);
  });

  test("still confirms idle even if the abort call throws", async () => {
    const stub = statusClient(["idle"], { abortThrows: true });
    const confirmed = await stopServerSession({ client: stub.client, repoDir: "/x", sessionID: "sid", timeoutMs: 2000 });
    expect(confirmed).toBe(true);
    expect(stub.aborts).toEqual(["sid"]);
  });
});

describe("sessionPendingState tri-state", () => {
  test("classifies busy / retry as pending, idle as idle, errors/missing distinctly", async () => {
    const busy = statusClient(["busy"]).client;
    const retry = statusClient(["retry"]).client;
    const idle = statusClient(["idle"]).client;
    const err = statusClient(["error"]).client;
    const thrown = statusClient(["throw"]).client;
    expect(await sessionPendingState(busy, "/x", "sid")).toBe("pending");
    expect(await sessionPendingState(retry, "/x", "sid")).toBe("pending");
    expect(await sessionPendingState(idle, "/x", "sid")).toBe("idle");
    expect(await sessionPendingState(err, "/x", "sid")).toBe("unknown");
    expect(await sessionPendingState(thrown, "/x", "sid")).toBe("unknown");
    // A session absent from the status map is idle (not pending), so a fresh
    // start/resume is allowed.
    const absent = {
      session: { status: async () => ({ data: { other: { type: "idle" } } }) },
    } as unknown as OpencodeClient;
    expect(await sessionPendingState(absent, "/x", "sid")).toBe("idle");
  });
});

describe("waitForSessionHealth", () => {
  const originalMaxWait = process.env.LOOPER_SERVER_RECOVERY_MAX_WAIT_MS;
  const originalProbe = process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS;
  const originalBase = process.env.LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS;
  const originalCap = process.env.LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS;

  afterEach(() => {
    if (originalMaxWait === undefined) delete process.env.LOOPER_SERVER_RECOVERY_MAX_WAIT_MS;
    else process.env.LOOPER_SERVER_RECOVERY_MAX_WAIT_MS = originalMaxWait;
    if (originalProbe === undefined) delete process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS;
    else process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS = originalProbe;
    if (originalBase === undefined) delete process.env.LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS;
    else process.env.LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS = originalBase;
    if (originalCap === undefined) delete process.env.LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS;
    else process.env.LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS = originalCap;
  });

  test("bounds hung status probes with the recovery deadline", async () => {
    process.env.LOOPER_SERVER_RECOVERY_MAX_WAIT_MS = "20";
    process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS = "1";
    process.env.LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS = "1";
    process.env.LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS = "1";
    const client = {
      session: {
        status: async () => await new Promise<never>(() => {}),
      },
    } as unknown as OpencodeClient;

    const state = await waitForSessionHealth({ client, repoDir: "/x", sessionID: "sid" });

    expect(state).toBe("unknown");
  });
});

/**
 * Orchestrator regression: a clean restart must confirm the prior session is
 * aborted BEFORE it creates the fresh restart session, so the old run cannot
 * keep generating in parallel with the new one (Bug 1).
 */
describe("clean restart stops the prior session before creating a new one", () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  function writeIdleContinuationRecord(repoDir: string, sessionID: string): void {
    const dir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `${sessionID}.json`),
      JSON.stringify({ sessionID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );
  }

  test("abort(ses_old) is ordered before create(ses_new)", async () => {
    scratch = mkdtempSync(join(tmpdir(), "looper-session-lifecycle-"));
    const repoDir = scratch;
    const configDir = join(scratch, ".local", "looper");
    mkdirSync(configDir, { recursive: true });
    initStatePaths({ configDir });
    writeFileSync(join(configDir, "build.md"), "build from scratch\n");
    writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    timeout: 1h\n");
    const state: LoopState = createLoopState({ maxIterations: 1, stepNames: ["Build"] });

    const sessionIDs = ["ses_old", "ses_new"];
    const created: string[] = [];
    const ops: string[] = [];

    const client = {
      session: {
        create: async () => {
          const id = sessionIDs[created.length];
          if (id === undefined) throw new Error("unexpected extra session.create");
          created.push(id);
          ops.push(`create:${id}`);
          return { data: { id } };
        },
        prompt: async (params: { sessionID: string }, options: { signal: AbortSignal }) => {
          ops.push(`prompt:${params.sessionID}`);
          if (params.sessionID === "ses_old") {
            state.restartRequested = true;
            state.restartReason = "manual";
            await new Promise<void>((resolve) => {
              if (options.signal.aborted) return resolve();
              options.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
          }
          writeIdleContinuationRecord(repoDir, params.sessionID);
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
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
          stream: (async function* (): AsyncGenerator<never> {
            await new Promise<void>((resolve) => {
              if (options.signal.aborted) return resolve();
              options.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })(),
        }),
      },
    } as unknown as OpencodeClient;

    const result = await runIteration({ state, iteration: 1, client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(created).toEqual(["ses_old", "ses_new"]);
    const abortOldIdx = ops.indexOf("abort:ses_old");
    const createNewIdx = ops.indexOf("create:ses_new");
    expect(abortOldIdx).toBeGreaterThanOrEqual(0);
    expect(createNewIdx).toBeGreaterThanOrEqual(0);
    expect(abortOldIdx).toBeLessThan(createNewIdx);
  });
});
