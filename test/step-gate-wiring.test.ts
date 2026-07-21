import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { runEngine } from "../src/engine/run-engine.ts";
import type { EngineFrontendHooks } from "../src/engine/engine-ports.ts";
import { loadSteps } from "../src/lib/config.ts";
import { runIteration, StepFailureError, type RunIterationHooks } from "../src/lib/orchestrator.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";
import { initStatePaths, readRunState } from "../src/lib/state-files.ts";
import { createRunStateStore } from "../src/persistence/run-state-store.ts";

type CompletionKind = NonNullable<Parameters<NonNullable<RunIterationHooks["onStepFinish"]>>[0]["completionKind"]>;

async function capturedRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
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

type StepSpec = {
  readonly key: string;
  readonly gateScript?: string;
  readonly gateBranch?: "main" | "story";
};

function setupScratch(steps: readonly StepSpec[]): { readonly repoDir: string; readonly configDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-step-gate-wiring-"));
  const configDir = join(repoDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  const lines = ["steps:"];
  for (const step of steps) {
    writeFileSync(join(configDir, `${step.key}.md`), `${step.key} prompt body\n`);
    lines.push(`  ${step.key}:`, `    prompt: ${step.key}.md`, "    timeout: 1h");
    if (step.gateScript !== undefined || step.gateBranch !== undefined) {
      lines.push("    gate:");
      if (step.gateBranch !== undefined) lines.push(`      branch: ${step.gateBranch}`);
      if (step.gateScript !== undefined) lines.push(`      script: ${JSON.stringify(step.gateScript)}`);
    }
  }
  writeFileSync(join(configDir, "looper.yaml"), `${lines.join("\n")}\n`);
  return { repoDir, configDir };
}

function makeClient(input: {
  readonly repoDir: string;
  readonly sessionIDs: readonly string[];
  readonly resumedSessionID?: string;
  readonly confirmStop?: boolean;
}): {
  readonly client: OpencodeClient;
  readonly calls: string[];
  readonly promptTexts: string[];
} {
  const calls: string[] = [];
  const created: string[] = [];
  const promptTexts: string[] = [];
  let resumedStopped = false;
  const client = {
    session: {
      create: async () => {
        const id = input.sessionIDs[created.length];
        if (id === undefined) throw new Error("unexpected extra session.create");
        created.push(id);
        calls.push(`create:${id}`);
        return { data: { id } };
      },
      prompt: async (params: { sessionID: string; parts: { type: string; text: string }[] }) => {
        calls.push(`prompt:${params.sessionID}`);
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        writeIdleContinuationRecord(input.repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => {
        calls.push("status");
        const data: Record<string, { type: string }> = {};
        for (const id of input.sessionIDs) data[id] = { type: "idle" };
        if (input.resumedSessionID !== undefined) {
          data[input.resumedSessionID] = { type: resumedStopped ? "idle" : "busy" };
        }
        return { data };
      },
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async ({ sessionID }: { sessionID: string }) => {
        calls.push(`abort:${sessionID}`);
        if (input.confirmStop !== false) resumedStopped = true;
        return { data: {} };
      },
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
  return { client, calls, promptTexts };
}

describe("runIteration step gate wiring", () => {
  const scratchDirs: string[] = [];
  const priorStopTimeout = process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (priorStopTimeout === undefined) delete process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"];
    else process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"] = priorStopTimeout;
  });

  test("a gated-out step creates no session, survives UI sync, and lets the next step run", async () => {
    // Given a first step whose script gate fails and a runnable second step.
    const { repoDir, configDir } = setupScratch([
      { key: "review", gateScript: "exit 7" },
      { key: "publish" },
    ]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["Review", "Publish"] });
    const stub = makeClient({ repoDir, sessionIDs: ["ses_publish"] });
    const begun: string[] = [];
    const completions: CompletionKind[] = [];

    // When the iteration runs.
    const result = await runIteration({
      state,
      iteration: 1,
      client: stub.client,
      repoDir,
      configDir,
      hooks: {
        onStepBegin: ({ step }) => begun.push(step.name),
        onStepFinish: ({ completionKind }) => completions.push(completionKind),
      },
    });

    // Then only the second step consumes an OpenCode session and both rows remain finalized.
    expect(result).toBe("complete");
    expect(stub.calls.filter((call) => call.startsWith("create:"))).toEqual(["create:ses_publish"]);
    expect(stub.calls.filter((call) => call.startsWith("prompt:"))).toEqual(["prompt:ses_publish"]);
    expect(state.steps.map((row) => [row.name, row.status])).toEqual([
      ["Review", "skipped"],
      ["Publish", "done"],
    ]);
    expect(state.agentLines).toContain("[looper] gate skipped Review: gate: script exited with code 7");
    expect(begun).toEqual(["Publish"]);
    expect(completions).toEqual(["gate-skip", "done"]);
    expect(stub.promptTexts[0]).not.toContain("Review (skipped)");
  });

  test("a declarative gate failure short-circuits its script", async () => {
    // Given a non-git directory whose story branch gate fails before a side-effecting script.
    const sentinel = join(tmpdir(), `looper-gate-sentinel-${crypto.randomUUID()}`);
    const { repoDir, configDir } = setupScratch([
      { key: "review", gateBranch: "story", gateScript: `touch ${JSON.stringify(sentinel)}` },
    ]);
    scratchDirs.push(repoDir);

    // When the iteration evaluates the gate.
    await runIteration({
      state: createLoopState({ maxIterations: 1, stepNames: ["Review"] }),
      iteration: 1,
      client: makeClient({ repoDir, sessionIDs: [] }).client,
      repoDir,
      configDir,
    });

    // Then the declarative rejection prevents the script side effect.
    expect(existsSync(sentinel)).toBe(false);
  });

  test("a gate skip confirms a persisted busy session stopped before completion", async () => {
    // Given a gated step resumed from a busy server session that can be stopped.
    const { repoDir, configDir } = setupScratch([{ key: "review", gateScript: "exit 1" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["Review"] });
    const stub = makeClient({ repoDir, sessionIDs: [], resumedSessionID: "ses_busy" });
    const calls = stub.calls;

    // When the gate is evaluated.
    await runIteration({
      state,
      iteration: 1,
      client: stub.client,
      repoDir,
      configDir,
      resume: { sessionID: "ses_busy", stepName: "Review" },
      hooks: { onStepFinish: ({ completionKind }) => calls.push(`finish:${completionKind}`) },
    });

    // Then abort and idle confirmation precede the durable gate-skip completion.
    expect(calls.indexOf("abort:ses_busy")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("status")).toBeGreaterThan(calls.indexOf("abort:ses_busy"));
    expect(calls.indexOf("finish:gate-skip")).toBeGreaterThan(calls.indexOf("status"));
    expect(calls.some((call) => call.startsWith("create:"))).toBe(false);
  });

  test("a gate skip fails closed when a persisted busy session cannot be confirmed stopped", async () => {
    // Given a gated step resumed from a server session that remains busy after abort.
    process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"] = "20";
    const { repoDir, configDir } = setupScratch([{ key: "review", gateScript: "exit 1" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["Review"] });
    const stub = makeClient({ repoDir, sessionIDs: [], resumedSessionID: "ses_busy", confirmStop: false });
    let completionCalled = false;

    // When the gate is evaluated.
    const run = runIteration({
      state,
      iteration: 1,
      client: stub.client,
      repoDir,
      configDir,
      resume: { sessionID: "ses_busy", stepName: "Review" },
      hooks: { onStepFinish: () => { completionCalled = true; } },
    });

    // Then the engine refuses to advance beyond the possibly-running session.
    expect(await capturedRejection(run)).toBeInstanceOf(StepFailureError);
    expect(completionCalled).toBe(false);
    expect(stub.calls.some((call) => call.startsWith("create:"))).toBe(false);
    expect(state.steps[0]?.status).not.toBe("skipped");
  });
});

describe("runEngine gate resume semantics", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("a crash after gate-skip advancement resumes at the next step", async () => {
    // Given a two-step run whose first step is gated out.
    const { repoDir, configDir } = setupScratch([
      { key: "review", gateScript: "exit 1" },
      { key: "publish" },
    ]);
    scratchDirs.push(repoDir);
    const store = createRunStateStore({ configDir });
    const firstClient = makeClient({ repoDir, sessionIDs: [] });
    const steps = () => loadSteps(configDir);
    const crash = new Error("simulated process death after persisted gate skip");

    // When the frontend dies immediately after the engine's gate-skip hook advances the pointer.
    const firstRun = runEngine<LoopState, OpencodeClient>({
      fresh: false,
      maxIterations: 1,
      waitProvided: false,
      waitDuration: 0,
      repoDir,
      configDir,
      client: firstClient.client,
      store,
      loadSteps: steps,
      currentBranch: async () => "main",
      createLooperRunID: () => "run-gate-resume",
      legacyResumeStepIndex: () => 0,
      runIteration: (input) => runIteration(input),
      hooks: {
        createIterationState: ({ maxIterations, steps: configured }) => createLoopState({ maxIterations, stepNames: configured.map((step) => step.name) }),
        onStepFinish: ({ completionKind }) => {
          if (completionKind === "gate-skip") throw crash;
        },
      },
    });
    expect(await capturedRejection(firstRun)).toBe(crash);
    expect(readRunState()?.stepName).toBe("Publish");

    // When --continue starts a new engine from that persisted pointer.
    const secondClient = makeClient({ repoDir, sessionIDs: ["ses_publish"] });
    await runEngine<LoopState, OpencodeClient>({
      fresh: false,
      maxIterations: 1,
      waitProvided: false,
      waitDuration: 0,
      repoDir,
      configDir,
      client: secondClient.client,
      store,
      loadSteps: steps,
      currentBranch: async () => "main",
      createLooperRunID: () => "unused-new-run-id",
      legacyResumeStepIndex: () => 0,
      runIteration: (input) => runIteration(input),
      hooks: {
        createIterationState: ({ maxIterations, steps: configured }) => createLoopState({ maxIterations, stepNames: configured.map((step) => step.name) }),
      },
    });

    // Then only the next step runs; the gated step is not revisited.
    expect(secondClient.calls.filter((call) => call.startsWith("create:"))).toEqual(["create:ses_publish"]);
  });

  test("runtime skips keep the resume pointer on the current step", async () => {
    // Given a run whose current step has an ordinary interruption-style skip.
    const { repoDir, configDir } = setupScratch([{ key: "review" }, { key: "publish" }]);
    scratchDirs.push(repoDir);
    const store = createRunStateStore({ configDir });
    const steps = loadSteps(configDir);
    const crash = new Error("inspect pointer after runtime skip");
    const frontendHooks: EngineFrontendHooks<LoopState> = {
      createIterationState: ({ maxIterations, steps: configured }) => createLoopState({ maxIterations, stepNames: configured.map((step) => step.name) }),
      onStepFinish: () => { throw crash; },
    };

    // When runIteration reports a runtime skip to the engine hook.
    const run = runEngine({
      fresh: false,
      maxIterations: 1,
      waitProvided: false,
      waitDuration: 0,
      repoDir,
      configDir,
      client: {},
      store,
      loadSteps: () => steps,
      currentBranch: async () => "main",
      createLooperRunID: () => "run-runtime-skip",
      legacyResumeStepIndex: () => 0,
      runIteration: async (input) => {
        const step = steps[0];
        if (step === undefined) throw new Error("missing test step");
        input.hooks?.onStepBegin?.({ step, index: 0, totalSteps: 2, iteration: 1 });
        input.hooks?.onStepFinish?.({ step, index: 0, nextIndex: 1, totalSteps: 2, iteration: 1, status: "skipped", completionKind: "runtime-skip" });
        return "complete";
      },
      hooks: frontendHooks,
    });
    expect(await capturedRejection(run)).toBe(crash);

    // Then the resume pointer still names the interrupted step.
    expect(readRunState()?.stepName).toBe("Review");
  });
});
