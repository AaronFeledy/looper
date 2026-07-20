import type { ContextPolicy, PermissionPolicy, QuestionPolicy, RecoverySnapshotsConfig, TitleGenConfig } from "../lib/config.ts";
import { StepFailureError, type ResumeSession } from "../lib/orchestrator.ts";
import type { Step } from "../lib/runner.ts";
import type { StepSessionEntry } from "../lib/state-files.ts";
import type { RunStateStoreStep } from "../persistence/run-state-store.ts";
import type { EngineFrontendHooks, EngineRunIteration, RunEngineOptions, RunEngineResult, RunStateStore } from "./engine-ports.ts";
import { buildEngineStepHooks } from "./run-engine-step-hooks.ts";
import type { AdjudicationConfig } from "./adjudication-routing.ts";

export type RunResumePlan = {
  readonly startIteration: number;
  readonly firstIterationStartStepIndex: number;
  readonly firstIterationResume: ResumeSession | undefined;
  readonly resumed: boolean;
  readonly firstIterationTitle: string | undefined;
  readonly firstIterationStepSessions: StepSessionEntry[] | undefined;
  readonly resetToFreshRun: boolean;
  readonly looperRunID: string | undefined;
};

export type ComputeRunResumePlanInput<StepLike extends RunStateStoreStep> = {
  readonly fresh: boolean;
  readonly maxIterations: number;
  readonly steps: readonly StepLike[];
  readonly store: RunStateStore;
  readonly legacyResumeStepIndex: (steps: readonly StepLike[]) => number;
};

export type RunEngineInput<S, Client> = RunEngineOptions & {
  readonly repoDir: string;
  readonly configDir: string;
  readonly client: Client;
  readonly store: RunStateStore;
  readonly hooks: EngineFrontendHooks<S, Step>;
  readonly loadSteps: () => Step[];
  readonly currentBranch: () => Promise<string>;
  readonly createLooperRunID: () => string;
  readonly legacyResumeStepIndex: (steps: readonly Step[]) => number;
  readonly runIteration: EngineRunIteration<S, Step, Client>;
  readonly titleGenConfig?: TitleGenConfig;
  readonly recoverySnapshots?: RecoverySnapshotsConfig;
  readonly permissionPolicy?: PermissionPolicy;
  readonly questionPolicy?: QuestionPolicy;
  readonly useSessionIdle?: boolean;
  readonly prdDir?: string;
  readonly adjudication?: AdjudicationConfig;
  readonly contextPolicy?: Partial<ContextPolicy>;
  readonly elapsedSeconds?: (startedAt: number) => number;
  readonly initialPlan?: RunResumePlan;
  readonly persistTitles?: boolean;
};

function stepSessionsForPlan(runState: ReturnType<RunStateStore["read"]>, iteration: number): StepSessionEntry[] | undefined {
  if (runState === null || runState.iteration !== iteration) return undefined;
  return runState.stepSessions;
}

function stepIndexFromRunState<StepLike extends RunStateStoreStep>(runState: NonNullable<ReturnType<RunStateStore["read"]>>, steps: readonly StepLike[]): number {
  const named = steps.findIndex((step) => step.name === runState.stepName);
  return named !== -1 ? named : Math.max(0, Math.min(steps.length - 1, runState.stepIndex));
}

function defaultElapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

export function computeRunResumePlan<StepLike extends RunStateStoreStep>(input: ComputeRunResumePlanInput<StepLike>): RunResumePlan {
  let startIteration = 1;
  let firstIterationStartStepIndex = 0;
  let firstIterationResume: ResumeSession | undefined;
  let resumed = false;
  let firstIterationTitle: string | undefined;
  let firstIterationStepSessions: StepSessionEntry[] | undefined;
  let looperRunID: string | undefined;

  if (!input.fresh) {
    const runState = input.store.read();
    if (runState !== null) {
      resumed = true;
      startIteration = Math.max(1, runState.iteration);
      firstIterationStartStepIndex = stepIndexFromRunState(runState, input.steps);
      firstIterationTitle = runState.title;
      firstIterationStepSessions = stepSessionsForPlan(runState, startIteration);
      looperRunID = runState.looperRunID;
      if (runState.sessionID !== undefined) {
        const looperMessageIDs = runState.looperMessageIDs ?? (runState.messageID !== undefined ? [runState.messageID] : undefined);
        firstIterationResume = {
          sessionID: runState.sessionID,
          ...(runState.messageID !== undefined ? { messageID: runState.messageID } : {}),
          stepName: runState.stepName,
          ...(runState.promptText !== undefined ? { promptText: runState.promptText } : {}),
          ...(looperMessageIDs !== undefined ? { looperMessageIDs: [...looperMessageIDs] } : {}),
        };
      }
    } else {
      firstIterationStartStepIndex = input.legacyResumeStepIndex(input.steps);
      resumed = firstIterationStartStepIndex > 0;
    }
  }

  if (startIteration > input.maxIterations) {
    input.store.clearRunArtifacts();
    return {
      startIteration: 1,
      firstIterationStartStepIndex: 0,
      firstIterationResume: undefined,
      resumed: false,
      firstIterationTitle: undefined,
      firstIterationStepSessions: undefined,
      resetToFreshRun: true,
      looperRunID: undefined,
    };
  }

  return {
    startIteration,
    firstIterationStartStepIndex,
    firstIterationResume,
    resumed,
    firstIterationTitle,
    firstIterationStepSessions,
    resetToFreshRun: false,
    looperRunID,
  };
}

function errorToFailure(error: StepFailureError): { readonly message: string; readonly stepName?: string; readonly sessionID?: string } {
  return {
    message: error.message,
    ...(error.stepName !== undefined ? { stepName: error.stepName } : {}),
    ...(error.sessionID !== undefined ? { sessionID: error.sessionID } : {}),
  };
}

export async function runEngine<S, Client>(input: RunEngineInput<S, Client>): Promise<RunEngineResult> {
  let looperRunID = input.store.read()?.looperRunID ?? input.createLooperRunID();
  const initialPlan = input.initialPlan ?? computeRunResumePlan({
    fresh: input.fresh,
    maxIterations: input.maxIterations,
    steps: input.loadSteps(),
    store: input.store,
    legacyResumeStepIndex: input.legacyResumeStepIndex,
  });
  let startIteration = initialPlan.startIteration;
  let firstIterationStartStepIndex = initialPlan.firstIterationStartStepIndex;
  let firstIterationResume = initialPlan.firstIterationResume;
  let firstIterationResumed = initialPlan.resumed;
  let firstIterationTitle = initialPlan.firstIterationTitle;
  let iterationStepSessions = initialPlan.firstIterationStepSessions ?? [];
  if (initialPlan.looperRunID !== undefined) looperRunID = initialPlan.looperRunID;
  if (initialPlan.resetToFreshRun) looperRunID = input.createLooperRunID();
  const persistTitles = input.persistTitles ?? true;
  if (!persistTitles) firstIterationTitle = undefined;

  let recoveryNudgeNext = false;
  let stepSessionsIteration: number | undefined;

  for (let iteration = startIteration; iteration <= input.maxIterations; iteration += 1) {
    if (input.store.stopFileExists() || input.store.stopAfterIterationFileExists()) {
      const reason = input.store.stopReason();
      await input.hooks.onStopRequested?.({ iteration, reason, phase: "before-iteration" });
      return { kind: "stopped", reason };
    }
    if (stepSessionsIteration !== iteration) {
      if (stepSessionsIteration !== undefined) iterationStepSessions = [];
      stepSessionsIteration = iteration;
    }

    const stepsSnapshot = input.loadSteps();
    const startStepIndex = iteration === startIteration ? firstIterationStartStepIndex : 0;
    const branch = await input.currentBranch();
    const state = input.hooks.createIterationState({ iteration, maxIterations: input.maxIterations, steps: stepsSnapshot, branch });
    await input.hooks.onIterationStart?.({
      state,
      iteration,
      maxIterations: input.maxIterations,
      steps: stepsSnapshot,
      startStepIndex,
      resumedPriorSteps: iteration === startIteration && firstIterationResumed,
    });

    const startedAt = Date.now();
    const resumeForThisIteration = iteration === startIteration ? firstIterationResume : undefined;
    const recoveryNudgeForThisIteration = recoveryNudgeNext;
    recoveryNudgeNext = false;

    try {
      const result = await input.runIteration({
        state,
        iteration,
        client: input.client,
        repoDir: input.repoDir,
        configDir: input.configDir,
        startStepIndex,
        stepsSnapshot,
        ...(resumeForThisIteration !== undefined ? { resume: resumeForThisIteration } : {}),
        ...(recoveryNudgeForThisIteration ? { recoveryNudge: true } : {}),
        ...(input.titleGenConfig !== undefined ? { titleGenConfig: input.titleGenConfig } : {}),
        ...(input.permissionPolicy !== undefined ? { permissionPolicy: input.permissionPolicy } : {}),
        ...(input.questionPolicy !== undefined ? { questionPolicy: input.questionPolicy } : {}),
        ...(input.useSessionIdle !== undefined ? { useSessionIdle: input.useSessionIdle } : {}),
        ...(input.prdDir !== undefined ? { prdDir: input.prdDir } : {}),
        ...(input.adjudication !== undefined
          ? { adjudication: { ...input.adjudication, writeStop: input.store.writeStop } }
          : {}),
        ...(input.contextPolicy !== undefined ? { contextPolicy: input.contextPolicy } : {}),
        ...(iteration === startIteration && firstIterationResumed ? { resumedPriorSteps: true } : {}),
        ...(persistTitles && iteration === startIteration && firstIterationTitle !== undefined ? { initialWorkDescription: firstIterationTitle } : {}),
        ...(iteration === startIteration && iterationStepSessions.length > 0 ? { resumedStepSessions: iterationStepSessions } : {}),
        looperRunID,
        maxIterations: input.maxIterations,
        recoverySnapshots: input.recoverySnapshots ?? false,
        hooks: buildEngineStepHooks({
          store: input.store,
          loadSteps: input.loadSteps,
          looperRunID,
          persistTitles,
          getStepSessions: () => iterationStepSessions,
          setStepSessions: (entries) => {
            iterationStepSessions = entries;
          },
          frontendHooks: input.hooks,
        }),
      });

      if (result === "stopped" || input.store.stopFileExists() || input.store.stopAfterIterationFileExists()) {
        const reason = input.store.stopReason();
        await input.hooks.onStopRequested?.({ iteration, reason, phase: "after-iteration" });
        return { kind: "stopped", reason };
      }
    } catch (error) {
      if (!(error instanceof StepFailureError) || input.hooks.onStepFailure === undefined || input.hooks.recoveryResumeForChoice === undefined) throw error;
      const choice = await input.hooks.onStepFailure({ state, error: errorToFailure(error) });
      if (choice === "quit" || input.store.stopFileExists() || input.store.stopAfterIterationFileExists()) {
        return { kind: "stopped", reason: input.store.stopReason() };
      }
      recoveryNudgeNext = choice === "nudge";
      const recoveryRunState = input.store.read();
      firstIterationResume = input.hooks.recoveryResumeForChoice({
        choice,
        ...(error.sessionID !== undefined ? { failedSessionID: error.sessionID } : {}),
        ...(error.stepName !== undefined ? { failedStepName: error.stepName } : {}),
        runState: recoveryRunState,
      });
      const recoverySteps = input.loadSteps();
      const failedStepIndex = recoveryRunState !== null ? stepIndexFromRunState(recoveryRunState, recoverySteps) : input.legacyResumeStepIndex(recoverySteps);
      startIteration = iteration;
      firstIterationStartStepIndex = failedStepIndex;
      firstIterationResumed = failedStepIndex > 0;
      firstIterationTitle = persistTitles ? recoveryRunState?.title : undefined;
      iterationStepSessions = iterationStepSessions.length > 0 ? iterationStepSessions : (recoveryRunState?.stepSessions ?? []);
      looperRunID = recoveryRunState?.looperRunID ?? looperRunID;
      input.store.clearStopFiles();
      await input.hooks.onRecoveryRetry?.({ state, choice });
      iteration -= 1;
      continue;
    }

    const elapsed = (input.elapsedSeconds ?? defaultElapsedSeconds)(startedAt);
    await input.hooks.onIterationComplete?.({ state, iteration, maxIterations: input.maxIterations, elapsedSeconds: elapsed });
    if (input.waitProvided) {
      const waitSeconds = input.waitDuration === "execution-time" ? elapsed : input.waitDuration * 60;
      await input.hooks.waitBetweenIterations?.({ state, seconds: waitSeconds, label: `Waiting ${waitSeconds}s` });
    }
  }

  input.store.clearRunArtifacts();
  await input.hooks.onMaxIterationsReached?.({ maxIterations: input.maxIterations });
  return { kind: "max-iterations" };
}
