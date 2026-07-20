import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { runEngine } from "../src/engine/run-engine.ts";
import { loadSteps } from "../src/lib/config.ts";
import { runIteration, StepFailureError, type RunIterationHooks } from "../src/lib/orchestrator.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";
import { initStatePaths, readRunState, writeRunState } from "../src/lib/state-files.ts";
import { createRunStateStore } from "../src/persistence/run-state-store.ts";

type TestClient = {
  readonly client: OpencodeClient;
  readonly calls: string[];
};

type TestClientInput = {
  readonly status: (call: number) => Promise<Record<string, { readonly type: "idle" | "busy" }>>;
  readonly abort?: (sessionID: string) => void;
};

function setupScratch(gated: boolean): { readonly repoDir: string; readonly configDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-step-gate-persistence-"));
  const configDir = join(repoDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  writeFileSync(join(configDir, "review.md"), "review prompt\n");
  writeFileSync(join(configDir, "publish.md"), "publish prompt\n");
  const gate = gated ? "    gate:\n      script: \"exit 1\"\n" : "";
  writeFileSync(
    join(configDir, "looper.yaml"),
    `steps:\n  review:\n    prompt: review.md\n    timeout: 1h\n${gate}  publish:\n    prompt: publish.md\n    timeout: 1h\n`,
  );
  return { repoDir, configDir };
}

function makeClient(input: TestClientInput): TestClient {
  const calls: string[] = [];
  let statusCalls = 0;
  const client: OpencodeClient = Object.assign(Object.create(null), {
    session: {
      create: async () => { throw new Error("gate/interruption test must not create a session"); },
      prompt: async () => { throw new Error("gate/interruption test must not prompt a session"); },
      status: async () => {
        statusCalls += 1;
        calls.push(`status:${statusCalls}`);
        return { data: await input.status(statusCalls) };
      },
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async ({ sessionID }: { readonly sessionID: string }) => {
        calls.push(`abort:${sessionID}`);
        input.abort?.(sessionID);
        return { data: {} };
      },
    },
    event: {
      subscribe: async (_params: unknown, options: { readonly signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> {
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) return resolve();
            options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
      }),
    },
  });
  return { client, calls };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

function runPersistedEngine(input: {
  readonly repoDir: string;
  readonly configDir: string;
  readonly client: OpencodeClient;
  readonly onState?: (state: LoopState) => void;
  readonly onStepFinish?: NonNullable<RunIterationHooks["onStepFinish"]>;
}): Promise<unknown> {
  const store = createRunStateStore({ configDir: input.configDir });
  return runEngine<LoopState, OpencodeClient>({
    fresh: false,
    maxIterations: 1,
    waitProvided: false,
    waitDuration: 0,
    repoDir: input.repoDir,
    configDir: input.configDir,
    client: input.client,
    store,
    loadSteps: () => loadSteps(input.configDir),
    currentBranch: async () => "main",
    createLooperRunID: () => "run-persistence-test",
    legacyResumeStepIndex: () => 0,
    runIteration: (options) => runIteration(options),
    hooks: {
      createIterationState: ({ maxIterations, steps }) => {
        const state = createLoopState({ maxIterations, stepNames: steps.map((step) => step.name) });
        input.onState?.(state);
        return state;
      },
      ...(input.onStepFinish !== undefined ? { onStepFinish: input.onStepFinish } : {}),
    },
  });
}

describe("persisted step-gate resume safety", () => {
  const scratchDirs: string[] = [];
  const priorStopTimeout = process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (priorStopTimeout === undefined) delete process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"];
    else process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"] = priorStopTimeout;
  });

  test("a real interruption skip leaves the persisted pointer on the current step", async () => {
    // Given a persisted in-flight step whose server health becomes unavailable.
    const scratch = setupScratch(false);
    scratchDirs.push(scratch.repoDir);
    writeRunState({ iteration: 1, stepIndex: 0, stepName: "Review", sessionID: "ses_busy", messageID: "msg_busy" });
    let state: LoopState | undefined;
    const crash = new Error("inspect pointer after real runtime skip");
    const stub = makeClient({
      status: async () => {
        if (state === undefined) throw new Error("iteration state was not created");
        state.skipRequested = true;
        throw new Error("server unavailable");
      },
    });

    // When runIteration observes the interruption through the composed run-engine hooks.
    const error = await rejectionOf(runPersistedEngine({
      ...scratch,
      client: stub.client,
      onState: (created) => { state = created; },
      onStepFinish: () => { throw crash; },
    }));

    // Then the runtime skip does not advance durable resume state.
    expect(error).toBe(crash);
    expect(readRunState()).toMatchObject({ iteration: 1, stepIndex: 0, stepName: "Review" });
    expect(stub.calls).toContain("status:1");
  });

  test("a persisted busy gate failure advances only after confirmed stop and otherwise fails closed", async () => {
    // Given a persisted busy session whose gate now fails and whose stop can be confirmed.
    const confirmed = setupScratch(true);
    scratchDirs.push(confirmed.repoDir);
    writeRunState({ iteration: 1, stepIndex: 0, stepName: "Review", sessionID: "ses_busy", messageID: "msg_busy" });
    let stopped = false;
    const persisted = new Error("inspect pointer after confirmed gate skip");
    const confirmedClient = makeClient({
      status: async () => ({ ses_busy: { type: stopped ? "idle" : "busy" } }),
      abort: () => { stopped = true; },
    });

    // When the engine confirms the stop and persists the gate-skip advance.
    const confirmedError = await rejectionOf(runPersistedEngine({
      ...confirmed,
      client: confirmedClient.client,
      onStepFinish: () => { throw persisted; },
    }));

    // Then confirmation precedes advancement to the next step.
    expect(confirmedError).toBe(persisted);
    expect(confirmedClient.calls).toEqual(["abort:ses_busy", "status:1"]);
    expect(readRunState()).toMatchObject({ iteration: 1, stepIndex: 1, stepName: "Publish" });

    // Given the same persisted busy state when stop confirmation is impossible.
    process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"] = "20";
    const unconfirmed = setupScratch(true);
    scratchDirs.push(unconfirmed.repoDir);
    writeRunState({ iteration: 1, stepIndex: 0, stepName: "Review", sessionID: "ses_stuck", messageID: "msg_stuck" });
    const stuckClient = makeClient({ status: async () => ({ ses_stuck: { type: "busy" } }) });

    // When the gate fails but the recorded session remains busy.
    const stuckError = await rejectionOf(runPersistedEngine({ ...unconfirmed, client: stuckClient.client }));

    // Then the engine fails closed and preserves the original in-flight pointer.
    expect(stuckError).toBeInstanceOf(StepFailureError);
    expect(readRunState()).toMatchObject({
      iteration: 1,
      stepIndex: 0,
      stepName: "Review",
      sessionID: "ses_stuck",
      messageID: "msg_stuck",
    });
  });
});
