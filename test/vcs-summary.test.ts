import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import type { ContextPolicy } from "../src/lib/config.ts";
import { runIteration } from "../src/lib/orchestrator.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, type LoopState, type VcsChange } from "../src/lib/state.ts";

/**
 * These tests exercise the legacy end-of-step `vcsSummary` display fetch,
 * which is independent from the `<looper-context>` prompt's own `vcsDelta`
 * fetch (by design - see prompt-context-injection plan Todo 3(c)). Disabling
 * just the prompt-side `vcsDelta` section keeps `vcs.status` call counts
 * exactly as this suite always expected, without touching unrelated context
 * sections or the product behavior under test.
 */
const PROMPT_VCS_DELTA_OFF: Partial<ContextPolicy> = { vcsDelta: false };

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function writeIdleContinuationRecord(repoDir: string, sessionID: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${sessionID}.json`),
    JSON.stringify({ sessionID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
  );
}

function setupScratch(): { repoDir: string; configDir: string; state: LoopState } {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-vcs-summary-"));
  const configDir = join(repoDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  writeFileSync(join(configDir, "build.md"), "build from scratch\n");
  writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    timeout: 1h\n");
  return { repoDir, configDir, state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }) };
}

type VcsStatusMode =
  | { kind: "ok"; changes: VcsChange[] }
  | { kind: "error"; message: string };

function makeSuccessClient(repoDir: string, mode: VcsStatusMode): {
  client: OpencodeClient;
  vcsStatusDirectories: string[];
} {
  const vcsStatusDirectories: string[] = [];
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_run" } }),
      prompt: async (params: { sessionID: string }) => {
        writeIdleContinuationRecord(repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { ses_run: { type: "idle" } } }),
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
    vcs: {
      status: async (params: { directory?: string }) => {
        if (params.directory !== undefined) vcsStatusDirectories.push(params.directory);
        if (mode.kind === "error") return { error: { message: mode.message } };
        return { data: mode.changes };
      },
    },
  } as unknown as OpencodeClient;
  return { client, vcsStatusDirectories };
}

describe("runIteration VCS summary", () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  test("vcsSummary=true records mapped VCS changes after a done step", async () => {
    const { repoDir, configDir, state } = setupScratch();
    scratch = repoDir;
    const changes: VcsChange[] = [
      { file: "src/new.ts", additions: 3, deletions: 0, status: "added" },
      { file: "README.md", additions: 1, deletions: 2, status: "modified" },
    ];
    const stub = makeSuccessClient(repoDir, { kind: "ok", changes });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, vcsSummary: true, contextPolicy: PROMPT_VCS_DELTA_OFF });

    expect(result).toBe("complete");
    expect(stub.vcsStatusDirectories).toEqual([repoDir]);
    expect(state.steps[0]!.status).toBe("done");
    expect(state.steps[0]!.vcsSummary).toEqual(changes);
  });

  test("vcsSummary=false preserves current behavior and does not call vcs.status", async () => {
    const { repoDir, configDir, state } = setupScratch();
    scratch = repoDir;
    const stub = makeSuccessClient(repoDir, { kind: "ok", changes: [{ file: "x", additions: 1, deletions: 0, status: "added" }] });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, vcsSummary: false, contextPolicy: PROMPT_VCS_DELTA_OFF });

    expect(result).toBe("complete");
    expect(stub.vcsStatusDirectories).toEqual([]);
    expect(state.steps[0]!.vcsSummary).toBeUndefined();
  });

  test("vcs.status errors are logged and never fail the done step", async () => {
    const { repoDir, configDir, state } = setupScratch();
    scratch = repoDir;
    const stub = makeSuccessClient(repoDir, { kind: "error", message: "not a git repository" });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, vcsSummary: true, contextPolicy: PROMPT_VCS_DELTA_OFF });

    expect(result).toBe("complete");
    expect(stub.vcsStatusDirectories).toEqual([repoDir]);
    expect(state.steps[0]!.status).toBe("done");
    expect(state.steps[0]!.vcsSummary).toBeUndefined();
    expect(state.steps[0]!.outputLines.some((line) => line.includes("vcs.status failed: not a git repository"))).toBe(true);
  });
});
