import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIteration } from "../src/engine/run-iteration.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths, readStopFile, writeStopFile } from "../src/lib/state-files.ts";

let repoDir: string;
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "looper-timeout-cap-"));
  initStatePaths({ configDir: repoDir });
  writeFileSync(join(repoDir, "build.md"), "Finish the build.");
  for (const key of ["LOOPER_TIMEOUT_RESTART_MAX", "LOOPER_CONTINUATION_POLL_MS"]) savedEnv.set(key, process.env[key]);
  process.env.LOOPER_CONTINUATION_POLL_MS = "10";
});
afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function runTimeouts(modes: readonly ("watchdog" | "background" | "manual" | "done")[], cap: number) {
  process.env.LOOPER_TIMEOUT_RESTART_MAX = String(cap);
  const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
  const calls: string[] = [];
  const prompts: string[] = [];
  let created = 0;
  const client = {
    session: {
      create: async () => {
        const id = `ses_${++created}`;
        calls.push(`create:${id}`);
        // Bound the reproducer even if the restart cap regresses.
        if (created > modes.length) state.quitting = true;
        return { data: { id } };
      },
      prompt: async (params: { sessionID: string; parts: { text?: string }[] }, options: { signal: AbortSignal }) => {
        prompts.push(params.parts.map(part => part.text ?? "").join("\n"));
        const mode = modes[created - 1] ?? "watchdog";
        if (mode === "watchdog" || mode === "manual") {
          if (mode === "manual") state.control.requestRestart("manual");
          await waitForAbort(options.signal);
          throw new DOMException("SDK request interrupted", "AbortError");
        }
        const dir = join(repoDir, ".omo", "run-continuation");
        mkdirSync(dir, { recursive: true });
        const updatedAt = new Date().toISOString();
        writeFileSync(join(dir, `${params.sessionID}.json`), JSON.stringify({
          sessionID: params.sessionID, updatedAt,
          sources: { "background-task": { state: mode === "background" ? "active" : "idle", updatedAt } },
        }));
        return { data: {} };
      },
      status: async () => ({ data: {} }),
      children: async () => ({ data: [] }),
      messages: async () => ({ data: [] }),
      abort: async ({ sessionID }: { sessionID: string }) => { calls.push(`abort:${sessionID}`); return { data: true }; },
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> { await waitForAbort(options.signal); })(),
      }),
    },
  } as unknown as OpencodeClient;
  const result = await runIteration({
    state, client, repoDir, configDir: repoDir, iteration: 1, writeStop: writeStopFile,
    stepsSnapshot: [{ name: "Build", prompt: join(repoDir, "build.md"), timeoutMs: modes.includes("manual") ? 1_000 : 100 }],
  });
  return { result, state, calls, prompts, created };
}

test.each([
  { label: "real watchdog, disabled", modes: ["watchdog"], cap: 0 },
  { label: "real watchdog, capped", modes: ["watchdog", "watchdog"], cap: 1 },
  { label: "background wait, disabled", modes: ["background"], cap: 0 },
  { label: "background wait, capped", modes: ["background", "background"], cap: 1 },
  { label: "watchdog then background wait", modes: ["watchdog", "background"], cap: 1 },
  { label: "background wait then watchdog", modes: ["background", "watchdog"], cap: 1 },
] as const)("timeout restart limit: $label", async ({ modes, cap }) => {
  const { result, state, calls, prompts, created } = await runTimeouts(modes, cap);
  expect(result).toBe("stopped");
  expect(created).toBe(cap + 1);
  expect(state.quitting).toBe(false);
  // Stop-file termination uses the existing skipped-row presentation.
  expect(state.steps.at(-1)?.status).toBe("skipped");
  expect(state.steps.filter(row => row.restartReason === "timeout")).toHaveLength(cap);
  expect(readStopFile()).toContain(`timeout restart limit reached (${cap}/${cap})`);
  expect(calls).toContain(`abort:ses_${cap + 1}`);
  for (let n = 1; n <= cap; n++) {
    expect(calls.indexOf(`abort:ses_${n}`)).toBeLessThan(calls.indexOf(`create:ses_${n + 1}`));
    expect(prompts[n]).toContain("clean restart in a new session");
  }
});

test("disabling watchdog restarts still permits a manual restart", async () => {
  const { result, state, created } = await runTimeouts(["manual", "done"], 0);
  expect(result).toBe("complete");
  expect(created).toBe(2);
  expect(state.steps.map(row => row.restartReason)).toEqual(["manual", undefined]);
  expect(readStopFile()).toBeNull();
});
