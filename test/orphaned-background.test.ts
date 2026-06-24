import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { resumeSessionWorkState, waitForLoopContinuationIdle } from "../src/lib/runner.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";

const SID = "ses_test";

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function freshRepo(): string {
  scratch = mkdtempSync(join(tmpdir(), "looper-orphan-"));
  const configDir = join(scratch, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  return scratch;
}

function writeActiveStaleRecord(repoDir: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  writeFileSync(
    join(dir, `${SID}.json`),
    JSON.stringify({ sessionID: SID, updatedAt: stale, sources: { "background-task": { state: "active", reason: "1 background task(s) active", updatedAt: stale } } }),
  );
}

function writeIdleRecord(repoDir: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${SID}.json`),
    JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
  );
}

type StatusType = "idle" | "busy" | "retry";

function makeClient(opts: { statusMap?: Record<string, StatusType>; children?: string[]; statusError?: boolean }): OpencodeClient {
  return {
    session: {
      status: async () => {
        await Bun.sleep(5);
        if (opts.statusError) return { error: { message: "status unavailable" } };
        const data: Record<string, { type: StatusType }> = {};
        for (const [id, type] of Object.entries(opts.statusMap ?? {})) data[id] = { type };
        return { data };
      },
      children: async () => {
        await Bun.sleep(5);
        return { data: (opts.children ?? []).map((id) => ({ id })) };
      },
    },
  } as unknown as OpencodeClient;
}

function state(): LoopState {
  const s = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
  s.activeStepIndex = 0;
  return s;
}

describe("waitForLoopContinuationIdle — stale marker no longer means dead", () => {
  test("active+stale marker with parent idle and NO live children -> orphaned", async () => {
    const repoDir = freshRepo();
    writeActiveStaleRecord(repoDir);
    const client = makeClient({ statusMap: { [SID]: "idle" }, children: [] });

    const result = await waitForLoopContinuationIdle({ state: state(), client, stepIndex: 0, repoDir, sessionID: SID, timeoutMs: 60_000 });

    expect(result).toBe("orphaned");
  });

  test("active+stale marker but a child session is still pending -> NOT orphaned (keeps waiting -> timeout)", async () => {
    const repoDir = freshRepo();
    writeActiveStaleRecord(repoDir);
    const client = makeClient({ statusMap: { [SID]: "idle", child1: "busy" }, children: ["child1"] });

    const result = await waitForLoopContinuationIdle({ state: state(), client, stepIndex: 0, repoDir, sessionID: SID, timeoutMs: 1 });

    expect(result).toBe("timeout");
  });

  test("active+stale marker but the live scan errors -> NOT orphaned (unknown, keeps waiting -> timeout)", async () => {
    const repoDir = freshRepo();
    writeActiveStaleRecord(repoDir);
    const client = makeClient({ statusError: true });

    const result = await waitForLoopContinuationIdle({ state: state(), client, stepIndex: 0, repoDir, sessionID: SID, timeoutMs: 1 });

    expect(result).toBe("timeout");
  });

  test("active+stale marker but parent still busy -> NOT orphaned (keeps waiting -> timeout)", async () => {
    const repoDir = freshRepo();
    writeActiveStaleRecord(repoDir);
    const client = makeClient({ statusMap: { [SID]: "busy" }, children: [] });

    const result = await waitForLoopContinuationIdle({ state: state(), client, stepIndex: 0, repoDir, sessionID: SID, timeoutMs: 1 });

    expect(result).toBe("timeout");
  });

  test("idle marker with parent idle -> idle (normal resume path)", async () => {
    const repoDir = freshRepo();
    writeIdleRecord(repoDir);
    const client = makeClient({ statusMap: { [SID]: "idle" }, children: [] });

    const result = await waitForLoopContinuationIdle({ state: state(), client, stepIndex: 0, repoDir, sessionID: SID, timeoutMs: 60_000 });

    expect(result).toBe("idle");
  });
});

describe("resumeSessionWorkState", () => {
  test("reports a busy saved foreground session as running", async () => {
    const repoDir = freshRepo();
    const client = makeClient({ statusMap: { [SID]: "busy" }, children: [] });

    const result = await resumeSessionWorkState({ client, repoDir, sessionID: SID });

    expect(result).toBe("running");
  });

  test("reports a fresh active background marker as running even when the parent is idle", async () => {
    const repoDir = freshRepo();
    const dir = join(repoDir, ".omo", "run-continuation");
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `${SID}.json`),
      JSON.stringify({ sessionID: SID, updatedAt: now, sources: { "background-task": { state: "active", reason: "1 background task(s) active", updatedAt: now } } }),
    );
    const client = makeClient({ statusMap: { [SID]: "idle" }, children: [] });

    const result = await resumeSessionWorkState({ client, repoDir, sessionID: SID });

    expect(result).toBe("running");
  });

  test("does not treat a stale orphaned background marker as running", async () => {
    const repoDir = freshRepo();
    writeActiveStaleRecord(repoDir);
    const client = makeClient({ statusMap: { [SID]: "idle" }, children: [] });

    const result = await resumeSessionWorkState({ client, repoDir, sessionID: SID });

    expect(result).toBe("idle");
  });

  test("can bound an unresponsive saved-session status check", async () => {
    const repoDir = freshRepo();
    const client = {
      session: {
        status: async () => await new Promise<never>(() => {}),
      },
    } as unknown as OpencodeClient;

    const result = await resumeSessionWorkState({ client, repoDir, sessionID: SID, statusTimeoutMs: 1 });

    expect(result).toBe("unknown");
  });

  test("can bound stale marker live probes", async () => {
    const repoDir = freshRepo();
    writeActiveStaleRecord(repoDir);
    const client = {
      session: {
        status: async () => ({ data: { [SID]: { type: "idle" } } }),
        children: async () => await new Promise<never>(() => {}),
      },
    } as unknown as OpencodeClient;

    const result = await resumeSessionWorkState({ client, repoDir, sessionID: SID, statusTimeoutMs: 1 });

    expect(result).toBe("unknown");
  });
});
