import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runEngine } from "../src/engine/run-engine.ts";
import { runIteration } from "../src/lib/orchestrator.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";
import { createAdjudicationStore } from "../src/persistence/adjudication-store.ts";
import { createRunStateStore } from "../src/persistence/run-state-store.ts";
import { createInMemoryAdjudicationStore } from "./helpers/adjudication-stub.ts";
import { adjudicatorErrorClient, backgroundResumptionClient, cleanupAdjudicationResumeScratch, setup, skippedRouteClient, unconfirmedTerminalClient } from "./helpers/adjudication-resume-stubs.ts";

afterEach(cleanupAdjudicationResumeScratch);

describe("adjudication failure and resume safety", () => {
  test("does not persist the dynamic adjudicator during background resumption", async () => {
    // Given a stale marker and an adjudicator resumed by OpenCode after background continuation.
    const scratch = setup();
    const adjudicationStore = createInMemoryAdjudicationStore();
    adjudicationStore.writeMarker("resume adjudication");
    const runStateStore = createRunStateStore({ configDir: scratch.configDir });
    const persistedRunStates: string[] = [];
    const stub = backgroundResumptionClient(scratch.repoDir);

    // When the dynamic adjudicator reaches the background-resumption callback path.
    await runIteration({
      state: createLoopState({ maxIterations: 1, stepNames: ["Step1"] }),
      iteration: 1,
      client: stub.client,
      ...scratch,
      useSessionIdle: true,
      hooks: {
        onStepSession: (info) => {
          runStateStore.savePosition({
            iteration: info.iteration,
            steps: [{ name: "Step1" }],
            stepIndex: info.index,
            stepName: info.stepName,
            sessionID: info.sessionID,
            messageID: info.messageID,
          });
          persistedRunStates.push(readFileSync(join(scratch.configDir, ".looper-run.json"), "utf8"));
        },
      },
      adjudication: { store: adjudicationStore, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} },
    });

    // Then no persisted position ever names the ephemeral row.
    expect(stub.backgroundResumptionReached()).toBeTrue();
    expect(persistedRunStates.some((snapshot) => snapshot.includes("adjudicate"))).toBeFalse();
  });

  test("advances a skipped triggering step before running the adjudicator", async () => {
    // Given a normal step that writes a marker and is then skipped.
    const scratch = setup();
    const adjudicationStore = createInMemoryAdjudicationStore();
    const runStateStore = createRunStateStore({ configDir: scratch.configDir });
    let state: LoopState | undefined;
    const routedStates: ReturnType<typeof runStateStore.read>[] = [];
    const client = skippedRouteClient({
      repoDir: scratch.repoDir,
      getState: () => state,
      writeMarker: () => adjudicationStore.writeMarker("route after skip"),
      observeRoute: () => routedStates.push(runStateStore.read()),
    });

    // When routing installs and runs the dynamic adjudicator row.
    await runEngine({
      fresh: false,
      maxIterations: 1,
      waitProvided: false,
      waitDuration: 0,
      ...scratch,
      client,
      store: runStateStore,
      hooks: {
        createIterationState: () => {
          state = createLoopState({ maxIterations: 1, stepNames: ["Step1"] });
          return state;
        },
      },
      loadSteps: () => [{ name: "Step1", prompt: join(scratch.configDir, "step1.md") }],
      currentBranch: async () => "main",
      createLooperRunID: () => "run",
      legacyResumeStepIndex: () => 0,
      runIteration,
      adjudication: { store: adjudicationStore, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2 },
    });

    // Then the durable pointer was already advanced to the next iteration.
    expect(routedStates).toHaveLength(1);
    expect(routedStates[0]).toMatchObject({ iteration: 2, stepIndex: 0, stepName: "Step1", looperRunID: "run" });
    expect(routedStates[0]?.sessionID).toBeUndefined();
  });

  test("retains the marker when adjudication fails before prompt dispatch", async () => {
    // Given a routed adjudicator whose session cannot be created.
    const scratch = setup();
    const adjudicationStore = createInMemoryAdjudicationStore();
    adjudicationStore.writeMarker("retry before dispatch");
    const state = createLoopState({ maxIterations: 1, stepNames: ["Step1"] });

    // When execution fails before a prompt can be dispatched.
    await runIteration({
      state,
      iteration: 1,
      client: adjudicatorErrorClient({ state, prompts: [], phase: "before-dispatch", repoDir: scratch.repoDir }),
      ...scratch,
      adjudication: { store: adjudicationStore, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} },
    });

    // Then the durable marker remains available for the next safe boundary.
    expect(adjudicationStore.readMarker()).toBe("retry before dispatch");
  });

  test("retains the file marker when prompt throws before returning a promise", async () => {
    // Given a file-backed marker and an adjudicator whose session binds successfully.
    const scratch = setup();
    const adjudicationStore = createAdjudicationStore({ configDir: scratch.configDir });
    adjudicationStore.writeMarker("retry synchronous prompt throw");
    const firstState = createLoopState({ maxIterations: 2, stepNames: ["Step1"] });

    // When the prompt call expression throws before returning its promise.
    await runIteration({
      state: firstState,
      iteration: 1,
      client: adjudicatorErrorClient({ state: firstState, prompts: [], phase: "sync-prompt-throw", repoDir: scratch.repoDir }),
      ...scratch,
      adjudication: { store: adjudicationStore, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} },
    });

    const nextPrompts: string[] = [];
    const nextState = createLoopState({ maxIterations: 2, stepNames: ["Step1"] });
    await runIteration({
      state: nextState,
      iteration: 2,
      client: adjudicatorErrorClient({ state: nextState, prompts: nextPrompts, phase: "success", repoDir: scratch.repoDir }),
      ...scratch,
      adjudication: { store: adjudicationStore, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} },
    });

    // Then the first boundary retained the marker and the next boundary re-fired adjudication.
    expect(nextPrompts).toHaveLength(1);
    expect(nextPrompts[0]).toContain("resolve the PRD conflict");
    expect(adjudicationStore.readMarker()).toBeNull();
  });

  test("retains the marker and re-routes after a dispatched adjudicator throws", async () => {
    // Given a routed adjudicator that throws during post-dispatch persistence.
    const scratch = setup();
    const adjudicationStore = createInMemoryAdjudicationStore();
    adjudicationStore.writeMarker("clear after dispatch");
    const firstState = createLoopState({ maxIterations: 2, stepNames: ["Step1"] });
    const adjudicationPrompts: string[] = [];
    const throwingStore = {
      ...adjudicationStore,
      appendHistory: (): never => {
        throw new Error("history persistence failed after dispatch");
      },
    };

    // When the prompt was dispatched before execution threw.
    let adjudicationError: unknown;
    try {
      await runIteration({
        state: firstState,
        iteration: 1,
        client: adjudicatorErrorClient({ state: firstState, prompts: adjudicationPrompts, phase: "after-dispatch", repoDir: scratch.repoDir, prdDir: scratch.prdDir }),
        ...scratch,
        adjudication: { store: throwingStore, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} },
      });
    } catch (error) {
      adjudicationError = error;
    }
    expect(adjudicationError).toBeInstanceOf(Error);
    expect(adjudicationError instanceof Error ? adjudicationError.message : "").toBe("history persistence failed after dispatch");

    // Then the durable marker survives (a failed adjudicator is never treated as resolved).
    expect(adjudicationStore.readMarker()).toBe("clear after dispatch");

    const nextPrompts: string[] = [];
    const nextState = createLoopState({ maxIterations: 2, stepNames: ["Step1"] });
    await runIteration({
      state: nextState,
      iteration: 2,
      client: adjudicatorErrorClient({ state: nextState, prompts: nextPrompts, phase: "success", repoDir: scratch.repoDir }),
      ...scratch,
      adjudication: { store: adjudicationStore, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} },
    });

    // And the next boundary re-routes to adjudication and clears the marker only on success.
    expect(adjudicationPrompts).toHaveLength(1);
    expect(nextPrompts).toHaveLength(1);
    expect(nextPrompts[0]).toContain("resolve the PRD conflict");
    expect(adjudicationStore.readMarker()).toBeNull();
  });

  test("defers adjudication when a terminal normal session cannot be confirmed stopped", async () => {
    // Given a terminal normal-step failure whose server health and abort cannot be confirmed.
    const scratch = setup();
    const adjudicationStore = createInMemoryAdjudicationStore();
    const state = createLoopState({ maxIterations: 1, stepNames: ["Step1"] });
    const adjudicationPrompts: string[] = [];
    const abortedSessions: string[] = [];
    const timeoutNames = [
      "LOOPER_SERVER_RECOVERY_MAX_WAIT_MS",
      "LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS",
      "LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS",
      "LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS",
      "LOOPER_STOP_SESSION_TIMEOUT_MS",
      "LOOPER_STOP_SESSION_POLL_MS",
    ] as const;
    const previousTimeouts = timeoutNames.map((name) => process.env[name]);
    for (const name of timeoutNames) process.env[name] = "1";

    // When the failure marker requests adjudication while that session may still be active.
    try {
      await runIteration({
        state,
        iteration: 1,
        client: unconfirmedTerminalClient({
          state,
          writeMarker: () => adjudicationStore.writeMarker("defer until stopped"),
          adjudicationPrompts,
          abortedSessions,
        }),
        ...scratch,
        adjudication: { store: adjudicationStore, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} },
      }).catch((error: unknown) => {
        if (!(error instanceof Error)) throw error;
      });
    } finally {
      for (const [index, name] of timeoutNames.entries()) {
        const previous = previousTimeouts[index];
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }

    // Then routing fails closed without launching adjudication and retains the marker.
    expect(adjudicationPrompts).toHaveLength(0);
    expect(abortedSessions).toContain("ses_1");
    expect(adjudicationStore.readMarker()).toBe("defer until stopped");
  });

  test("defers iteration-start routing when a resumed session cannot be confirmed stopped", async () => {
    // Given an iteration-start marker and a pending resume session with an unconfirmed stop.
    const scratch = setup();
    const adjudicationStore = createInMemoryAdjudicationStore();
    adjudicationStore.writeMarker("retry initial route");
    const state = createLoopState({ maxIterations: 1, stepNames: ["Step1"] });
    const adjudicationPrompts: string[] = [];
    const abortedSessions: string[] = [];
    const previousTimeout = process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"];
    const previousPoll = process.env["LOOPER_STOP_SESSION_POLL_MS"];
    process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"] = "1";
    process.env["LOOPER_STOP_SESSION_POLL_MS"] = "1";
    let routed = false;

    // When iteration-start routing attempts to reconcile the pending session.
    try {
      await runIteration({
        state,
        iteration: 1,
        client: unconfirmedTerminalClient({ state, writeMarker: () => {}, adjudicationPrompts, abortedSessions }),
        ...scratch,
        resume: { sessionID: "ses_pending", messageID: "msg_pending", stepName: "Step1" },
        hooks: { onAdjudicationRoute: () => { routed = true; } },
        adjudication: { store: adjudicationStore, step: { name: "adjudicate", prompt: join(scratch.configDir, "adjudicate.md") }, threshold: 2, writeStop: () => {} },
      }).catch((error: unknown) => {
        if (!(error instanceof Error)) throw error;
      });
    } finally {
      if (previousTimeout === undefined) delete process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"];
      else process.env["LOOPER_STOP_SESSION_TIMEOUT_MS"] = previousTimeout;
      if (previousPoll === undefined) delete process.env["LOOPER_STOP_SESSION_POLL_MS"];
      else process.env["LOOPER_STOP_SESSION_POLL_MS"] = previousPoll;
    }

    // Then checkpoint routing and adjudication are deferred while the marker survives.
    expect(routed).toBeFalse();
    expect(adjudicationPrompts).toHaveLength(0);
    expect(abortedSessions).toContain("ses_pending");
    expect(adjudicationStore.readMarker()).toBe("retry initial route");
  });
});
