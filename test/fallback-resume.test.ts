import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { computeNonTtyResumePlan, runNonTtyIterations } from "../src/lib/fallback.ts";
import { initStatePaths, readRunState, writeRunState } from "../src/lib/state-files.ts";

function setupScratch(stepKeys: string[]): { repoDir: string; configDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-fallback-resume-"));
  const configDir = join(repoDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  const lines = ["steps:"];
  for (const key of stepKeys) {
    writeFileSync(join(configDir, `${key}.md`), `${key} prompt body\n`);
    lines.push(`  ${key}:`, `    prompt: ${key}.md`, `    timeout: 1h`);
  }
  writeFileSync(join(configDir, "looper.yaml"), `${lines.join("\n")}\n`);
  return { repoDir, configDir };
}

describe("computeNonTtyResumePlan", () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  test("fresh config with no persisted state starts at iteration 1, step 0, with no resumed data", () => {
    const { repoDir, configDir } = setupScratch(["build", "review"]);
    scratch = repoDir;
    const plan = computeNonTtyResumePlan(configDir, { fresh: false, maxIterations: 5 });
    expect(plan).toEqual({
      startIteration: 1,
      firstStartStepIndex: 0,
      firstIterationResume: undefined,
      firstIterationResumedPriorSteps: false,
      iterationStepSessions: [],
      resetToFreshRun: false,
    });
  });

  test("mid-iteration run-state resumes with resumedPriorSteps + persisted stepSessions", () => {
    const { repoDir, configDir } = setupScratch(["build", "review"]);
    scratch = repoDir;
    writeRunState({
      iteration: 2,
      stepIndex: 1,
      stepName: "review",
      stepSessions: [{ stepIndex: 0, stepName: "build", sessionID: "ses_build_prior" }],
    });
    const plan = computeNonTtyResumePlan(configDir, { fresh: false, maxIterations: 5 });
    expect(plan.startIteration).toBe(2);
    expect(plan.firstStartStepIndex).toBe(1);
    expect(plan.firstIterationResumedPriorSteps).toBe(true);
    expect(plan.iterationStepSessions).toEqual([{ stepIndex: 0, stepName: "build", sessionID: "ses_build_prior" }]);
    expect(plan.resetToFreshRun).toBe(false);
  });

  test("old-format run-state (no stepSessions field) resumes without step sessions", () => {
    const { repoDir, configDir } = setupScratch(["build", "review"]);
    scratch = repoDir;
    writeRunState({ iteration: 2, stepIndex: 1, stepName: "review" });
    const plan = computeNonTtyResumePlan(configDir, { fresh: false, maxIterations: 5 });
    expect(plan.firstIterationResumedPriorSteps).toBe(true);
    expect(plan.iterationStepSessions).toEqual([]);
  });

  test("--fresh ignores persisted run-state entirely", () => {
    const { repoDir, configDir } = setupScratch(["build", "review"]);
    scratch = repoDir;
    writeRunState({
      iteration: 3,
      stepIndex: 1,
      stepName: "review",
      stepSessions: [{ stepIndex: 0, stepName: "build", sessionID: "ses_build_prior" }],
    });
    const plan = computeNonTtyResumePlan(configDir, { fresh: true, maxIterations: 5 });
    expect(plan).toEqual({
      startIteration: 1,
      firstStartStepIndex: 0,
      firstIterationResume: undefined,
      firstIterationResumedPriorSteps: false,
      iterationStepSessions: [],
      resetToFreshRun: false,
    });
  });

  test("a persisted iteration beyond maxIterations resets to a fresh run and drops step sessions", () => {
    const { repoDir, configDir } = setupScratch(["build", "review"]);
    scratch = repoDir;
    writeRunState({
      iteration: 9,
      stepIndex: 1,
      stepName: "review",
      stepSessions: [{ stepIndex: 0, stepName: "build", sessionID: "ses_build_prior" }],
    });
    const plan = computeNonTtyResumePlan(configDir, { fresh: false, maxIterations: 2 });
    expect(plan.resetToFreshRun).toBe(true);
    expect(plan.startIteration).toBe(1);
    expect(plan.firstStartStepIndex).toBe(0);
    expect(plan.firstIterationResumedPriorSteps).toBe(false);
    expect(plan.iterationStepSessions).toEqual([]);
  });

  test("legacy resume-step-only checkpoint (no run-state file) sets resumedPriorSteps without step sessions", () => {
    const { repoDir, configDir } = setupScratch(["build", "review"]);
    scratch = repoDir;
    // No .looper-run.json; simulate the legacy resume-step file by writing
    // run-state once then clearing just the run-state file is unnecessary —
    // resumeStepIndex() reads .looper-resume-step.json directly, so write it
    // via the same on-disk contract main.ts/fallback.ts already use.
    writeFileSync(
      join(configDir, ".looper-resume-step.json"),
      JSON.stringify({ stepIndex: 1, stepName: "review", updatedAt: new Date().toISOString() }),
    );
    const plan = computeNonTtyResumePlan(configDir, { fresh: false, maxIterations: 5 });
    expect(plan.startIteration).toBe(1);
    expect(plan.firstStartStepIndex).toBe(1);
    expect(plan.firstIterationResumedPriorSteps).toBe(true);
    expect(plan.iterationStepSessions).toEqual([]);
    expect(readRunState()).toBeNull();
  });
});

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

/** All-succeed client that hands out `sessionIDs` in `session.create()` call order. */
function makeClient(opts: { repoDir: string; sessionIDs: string[] }): { client: OpencodeClient; promptTexts: string[] } {
  const { repoDir, sessionIDs } = opts;
  const created: string[] = [];
  const promptTexts: string[] = [];
  const statusMap: Record<string, { type: string }> = {};
  for (const id of sessionIDs) statusMap[id] = { type: "idle" };

  const client = {
    session: {
      create: async () => {
        const id = sessionIDs[created.length];
        if (id === undefined) throw new Error("unexpected extra session.create");
        created.push(id);
        return { data: { id } };
      },
      prompt: async (params: { sessionID: string; parts: { type: string; text: string }[] }) => {
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        writeIdleContinuationRecord(repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: statusMap }),
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

  return { client, promptTexts };
}

describe("runNonTtyIterations resume wiring", () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  test(
    "mid-iteration resume injects the persisted prior session into the resumed step's prompt, and stepSessions is dropped the moment the loop crosses into the next iteration",
    async () => {
      const { repoDir, configDir } = setupScratch(["build", "review"]);
      scratch = repoDir;
      writeRunState({
        iteration: 1,
        stepIndex: 1,
        stepName: "review",
        stepSessions: [{ stepIndex: 0, stepName: "build", sessionID: "ses_build_prior" }],
      });

      const { client, promptTexts } = makeClient({
        repoDir,
        sessionIDs: ["ses_review_1", "ses_build_2", "ses_review_2"],
      });

      let branchCalls = 0;
      let runStateAtIteration2Start: ReturnType<typeof readRunState> = null;
      const currentBranch = async (): Promise<string> => {
        branchCalls += 1;
        if (branchCalls === 3) runStateAtIteration2Start = readRunState();
        return "main";
      };

      // runNonTtyIterations sets process.exitCode=1 on "max iterations
      // reached" (real CLI behavior); restore it so this test's outcome
      // doesn't leak into the overall test-runner process's exit status.
      // Bun does not clear a previously-set process.exitCode by assigning
      // `undefined` back to it, so this explicitly restores a numeric 0.
      const priorExitCode = process.exitCode ?? 0;
      try {
        await runNonTtyIterations({
          options: { attach: false, configDir, fresh: false, maxIterations: 2, start: true, waitProvided: false, waitDuration: 0 },
          repoDir,
          configDir,
          client,
          recoverySnapshots: false,
          currentBranch,
        });
      } finally {
        process.exitCode = priorExitCode;
      }

      // The resumed step (iteration 1's "review") saw the persisted prior
      // step's opencode session in its <looper-context> block.
      expect(promptTexts[0]).toContain("Opencode sessions from earlier steps this iteration:");
      expect(promptTexts[0]).toContain("ses_build_prior");

      // At the start of iteration 2 (captured via the 3rd currentBranch()
      // call: iter1-start, iter1-end-print, iter2-start), the pointer had
      // already crossed the iteration boundary and carries NO stepSessions.
      expect(runStateAtIteration2Start).not.toBeNull();
      expect(runStateAtIteration2Start!.iteration).toBe(2);
      expect(runStateAtIteration2Start!.stepIndex).toBe(0);
      expect(runStateAtIteration2Start!.stepSessions).toBeUndefined();

      // The whole run finished (max iterations reached) and cleared state.
      expect(readRunState()).toBeNull();
    },
    15000,
  );
});
