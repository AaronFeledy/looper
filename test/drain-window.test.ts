import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { stopServerSession, waitForLoopContinuationIdle } from "../src/lib/runner.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";

type StatusType = "idle" | "busy" | "retry";

function killStub(statuses: StatusType[], childCount: number): {
  client: OpencodeClient;
  aborts: string[];
  statusCalls: () => number;
  childrenCalls: () => number;
} {
  const aborts: string[] = [];
  const counters = { status: 0, children: 0 };
  const client = {
    session: {
      abort: async ({ sessionID }: { sessionID: string }) => {
        aborts.push(sessionID);
        return { data: {} };
      },
      status: async () => {
        const idx = Math.min(counters.status, statuses.length - 1);
        counters.status += 1;
        return { data: { sid: { type: statuses[idx] } } };
      },
      children: async () => {
        counters.children += 1;
        return { data: Array.from({ length: childCount }, (_v, i) => ({ id: `c${i}` })) };
      },
    },
  } as unknown as OpencodeClient;
  return { client, aborts, statusCalls: () => counters.status, childrenCalls: () => counters.children };
}

describe("stopServerSession drain window (kill path)", () => {
  test("re-aborts a session revived by a late background wake, then confirms it stays dead", async () => {
    const stub = killStub(["idle", "busy", "idle", "idle"], 1);
    const confirmed = await stopServerSession({
      client: stub.client,
      repoDir: "/x",
      sessionID: "sid",
      timeoutMs: 2000,
      drainWindowMs: 60,
    });
    expect(confirmed).toBe(true);
    expect(stub.aborts).toEqual(["sid", "sid"]);
    expect(stub.childrenCalls()).toBe(1);
  });

  test("skips the drain entirely when the session never spawned background agents", async () => {
    const stub = killStub(["idle"], 0);
    const startedAt = Date.now();
    const confirmed = await stopServerSession({
      client: stub.client,
      repoDir: "/x",
      sessionID: "sid",
      timeoutMs: 2000,
      drainWindowMs: 5000,
    });
    expect(confirmed).toBe(true);
    expect(stub.aborts).toEqual(["sid"]);
    expect(stub.childrenCalls()).toBe(1);
    expect(stub.statusCalls()).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  test("default (drainWindowMs=0) preserves the fast path and never queries children", async () => {
    const stub = killStub(["idle"], 1);
    const confirmed = await stopServerSession({ client: stub.client, repoDir: "/x", sessionID: "sid", timeoutMs: 2000 });
    expect(confirmed).toBe(true);
    expect(stub.aborts).toEqual(["sid"]);
    expect(stub.childrenCalls()).toBe(0);
  });

  test("returns false (not a false stop-confirm) when the session keeps reviving past the drain deadline", async () => {
    const stub = killStub(["idle", "busy"], 1);
    const confirmed = await stopServerSession({
      client: stub.client,
      repoDir: "/x",
      sessionID: "sid",
      timeoutMs: 5000,
      drainWindowMs: 40,
    });
    expect(confirmed).toBe(false);
    expect(stub.aborts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("waitForLoopContinuationIdle drain window (settle path)", () => {
  let scratch: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  function writeIdleRecord(repoDir: string, sessionID: string): void {
    const dir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `${sessionID}.json`),
      JSON.stringify({ sessionID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
    );
  }

  test("does not settle while the parent is still busy; only returns idle after it stays idle through the window", async () => {
    scratch = mkdtempSync(join(tmpdir(), "looper-drain-"));
    const configDir = join(scratch, ".looper");
    mkdirSync(configDir, { recursive: true });
    initStatePaths({ configDir });
    writeIdleRecord(scratch, "sid");
    setEnv("LOOPER_CONTINUATION_DRAIN_MS", "120");
    setEnv("LOOPER_CONTINUATION_DRAIN_POLL_MS", "20");
    setEnv("LOOPER_CONTINUATION_POLL_MS", "20");

    const flipAt = Date.now() + 100;
    const client = {
      session: {
        status: async () => ({ data: { sid: { type: Date.now() < flipAt ? "busy" : "idle" } } }),
        children: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient;

    const state: LoopState = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const startedAt = Date.now();
    const result = await waitForLoopContinuationIdle({
      state,
      client,
      stepIndex: 0,
      repoDir: scratch,
      sessionID: "sid",
      timeoutMs: 60_000,
    });
    const elapsed = Date.now() - startedAt;

    expect(result).toBe("idle");
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });

  test("does not settle while session.status is unknown; a status error holds, never advances, the drain", async () => {
    scratch = mkdtempSync(join(tmpdir(), "looper-drain-"));
    const configDir = join(scratch, ".looper");
    mkdirSync(configDir, { recursive: true });
    initStatePaths({ configDir });
    writeIdleRecord(scratch, "sid");
    setEnv("LOOPER_CONTINUATION_DRAIN_MS", "40");
    setEnv("LOOPER_CONTINUATION_DRAIN_POLL_MS", "20");
    setEnv("LOOPER_CONTINUATION_POLL_MS", "20");

    const client = {
      session: {
        status: async () => ({ error: { message: "status unavailable" } }),
        children: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient;

    const state: LoopState = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const result = await waitForLoopContinuationIdle({
      state,
      client,
      stepIndex: 0,
      repoDir: scratch,
      sessionID: "sid",
      timeoutMs: 250,
    });

    expect(result).toBe("timeout");
  });
});
