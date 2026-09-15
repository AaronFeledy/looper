import type { ContextPolicy, PermissionPolicy, QuestionPolicy, RecoverySnapshotsConfig, TitleGenConfig } from "../lib/config.ts";
import { StepFailureError, type ResumeSession } from "../lib/orchestrator.ts";
import type { Step } from "../lib/runner.ts";
import type { StepSessionEntry } from "../lib/state-files.ts";
import type { RunStateStoreStep } from "../persistence/run-state-store.ts";
import type { EngineFrontendHooks, EngineRunIteration, RunEngineOptions, RunEngineResult, RunStateStore, StoryStatePort } from "./engine-ports.ts";
import { buildEngineStepHooks } from "./run-engine-step-hooks.ts";
import type { AdjudicationConfig } from "./adjudication-routing.ts";
import { createStallObserver, stallDetectionEnabled, type StallLimits, type StallObserver } from "./stall-detector.ts";
import { createInFlightProbe, runStallCheck } from "./stall-quiescence.ts";
import { stallConfirmMs } from "../config/tunables.ts";
import type { RunControl } from "./run-control.ts";
import { isPrdComplete, type StoryPhaseResolver } from "./story-phases.ts";
import { stopServerSession } from "../opencode/session-health.ts";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

export type RunResumePlan = {
  readonly startIteration: number;
  readonly firstIterationStartStepIndex: number;
  readonly firstIterationResume: ResumeSession | undefined;
  readonly resumed: boolean;
  readonly firstIterationTitle: string | undefined;
  readonly firstIterationStepSessions: StepSessionEntry[] | undefined;
  readonly resetToFreshRun: boolean;
  readonly looperRunID: string | undefined;
  /** In-flight session from a checkpoint whose step no longer exists; must be stopped before starting replacement work. */
  readonly staleSessionID?: string;
};

export type ComputeRunResumePlanInput<StepLike extends RunStateStoreStep> = {
  readonly fresh: boolean;
  readonly maxIterations: number;
  readonly steps: readonly StepLike[];
  readonly store: RunStateStore;
  readonly legacyResumeStepIndex: (steps: readonly StepLike[]) => number;
  readonly log?: (line: string) => void;
};

export type RunEngineInput<S, Client> = RunEngineOptions & {
  readonly control?: RunControl;
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
  readonly unattended?: boolean;
  readonly useSessionIdle?: boolean;
  readonly prdDir?: string;
  readonly storyIdPattern?: string;
  readonly storyState?: StoryStatePort;
  readonly storyResolver?: StoryPhaseResolver;
  readonly adjudication?: AdjudicationConfig;
  readonly stall?: StallLimits;
  readonly stallConfirmMs?: number;
  readonly contextPolicy?: Partial<ContextPolicy>;
  readonly elapsedSeconds?: (startedAt: number) => number;
  readonly initialPlan?: RunResumePlan;
  readonly persistTitles?: boolean;
  readonly log?: (line: string) => void;
};

function stepSessionsForPlan(runState: ReturnType<RunStateStore["read"]>, iteration: number): StepSessionEntry[] | undefined {
  if (runState === null || runState.iteration !== iteration) return undefined;
  return runState.stepSessions;
}

function stepIndexFromRunState<StepLike extends RunStateStoreStep>(runState: NonNullable<ReturnType<RunStateStore["read"]>>, steps: readonly StepLike[]): number {
  if (steps[runState.stepIndex]?.name === runState.stepName) return runState.stepIndex;
  const named = steps.findIndex((step) => step.name === runState.stepName);
  const unique = named !== -1 && steps.filter((step) => step.name === runState.stepName).length === 1;
  return unique ? named : Math.max(0, Math.min(steps.length - 1, runState.stepIndex));
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
  let staleSessionID: string | undefined;

  if (!input.fresh) {
    const runState = input.store.read();
    if (runState !== null) {
      looperRunID = runState.looperRunID;
      const namePresent = input.steps.some((step) => step.name === runState.stepName);
      if (!namePresent) {
        startIteration = Math.max(1, runState.iteration + 1);
        staleSessionID = runState.sessionID;
        input.log?.(
          `[looper] saved resume step ${runState.stepIndex} (${runState.stepName}) no longer matches configuration; continuing at iteration ${startIteration}, step 0`,
        );
      } else {
        resumed = true;
        startIteration = Math.max(1, runState.iteration);
        firstIterationStartStepIndex = stepIndexFromRunState(runState, input.steps);
        firstIterationTitle = runState.title;
        firstIterationStepSessions = stepSessionsForPlan(runState, startIteration);
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
      ...(staleSessionID !== undefined ? { staleSessionID } : {}),
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
    ...(staleSessionID !== undefined ? { staleSessionID } : {}),
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
  const checkpointSessionID = input.store.read()?.sessionID;
  const resumeSessionID = initialPlan.firstIterationResume?.sessionID;
  const staleSessionID = initialPlan.staleSessionID ?? (
    !input.fresh && checkpointSessionID !== undefined && checkpointSessionID !== resumeSessionID
      ? checkpointSessionID
      : undefined
  );
  if (staleSessionID !== undefined) {
    const stopped = await stopServerSession({
      client: input.client as OpencodeClient,
      repoDir: input.repoDir,
      sessionID: staleSessionID,
      log: input.log,
    });
    if (!stopped) {
      const reason = `could not confirm session ${staleSessionID} stopped; not starting a replacement run to avoid overlapping opencode generations`;
      input.log?.(`[looper] ${reason}`);
      return { kind: "stopped", reason };
    }
    input.log?.(`[looper] stopped stale checkpoint session ${staleSessionID} before continuing`);
  }
  const persistTitles = input.persistTitles ?? true;
  if (!persistTitles) firstIterationTitle = undefined;
  const stopRequested = (): boolean =>
    input.control?.quitting === true ||
    input.control?.stopAfterIteration === true ||
    input.store.stopFileExists() ||
    input.store.stopAfterIterationFileExists();
  const loggedUnreadablePrd = new Set<number>();
  const stopForCompletedPrd = async (
    iteration: number,
    phase: "before-iteration" | "after-iteration",
  ): Promise<RunEngineResult | undefined> => {
    const resolver = input.storyResolver;
    if (resolver === undefined) return undefined;
    await resolver.fetchMain();
    const snapshot = resolver.snapshot();
    if (snapshot === undefined || snapshot.stories.length === 0) {
      if (!loggedUnreadablePrd.has(iteration)) {
        loggedUnreadablePrd.add(iteration);
        input.log?.(
          snapshot === undefined
            ? "[looper] PRD completion check skipped: story snapshot is unreadable"
            : "[looper] PRD completion check skipped: no stories configured",
        );
      }
      return undefined;
    }
    if (!isPrdComplete(snapshot)) return undefined;
    const reason = `PRD complete: ${snapshot.stories.length}/${snapshot.stories.length} stories at phase ${snapshot.terminal}`;
    input.store.writeStop(reason);
    await input.hooks.onStopRequested?.({ iteration, reason, phase });
    return { kind: "stopped", reason };
  };

  let recoveryNudgeNext = false;
  let recoveryStateNext: { readonly state: S } | undefined;
  let recoveryStepsNext: Step[] | undefined;
  let stepSessionsIteration: number | undefined;
  let iterationStartedAt = Date.now();

  const stallObserver: StallObserver | undefined =
    input.stall !== undefined && stallDetectionEnabled(input.stall)
      ? createStallObserver({
          repoDir: input.repoDir,
          limits: input.stall,
          ...(input.prdDir !== undefined ? { prdDir: input.prdDir } : {}),
          ...(input.storyIdPattern !== undefined ? { storyIdPattern: input.storyIdPattern } : {}),
          ...(input.storyState !== undefined ? { readPhase: input.storyState.readPhase } : {}),
          ...(input.storyResolver !== undefined
            ? { readPhases: () => input.storyResolver?.snapshot()?.phases }
            : {}),
          readCompletionsCount: () => input.adjudication?.store.readCompletions().length ?? 0,
          probeInFlight: createInFlightProbe({
            repoDir: input.repoDir,
            client: input.client,
            currentIteration: () => ({ sessions: iterationStepSessions, startedAt: iterationStartedAt }),
          }),
        })
      : undefined;

  for (let iteration = startIteration; iteration <= input.maxIterations; iteration += 1) {
    if (stopRequested()) {
      const reason = input.store.stopReason();
      await input.hooks.onStopRequested?.({ iteration, reason, phase: "before-iteration" });
      return { kind: "stopped", reason };
    }
    const completedBeforeIteration = await stopForCompletedPrd(iteration, "before-iteration");
    if (completedBeforeIteration !== undefined) return completedBeforeIteration;
    if (stepSessionsIteration !== iteration) {
      if (stepSessionsIteration !== undefined) iterationStepSessions = [];
      stepSessionsIteration = iteration;
    }

    const stepsSnapshot = recoveryStepsNext ?? input.loadSteps();
    recoveryStepsNext = undefined;
    const startStepIndex = iteration === startIteration ? firstIterationStartStepIndex : 0;
    const recoveryState = recoveryStateNext;
    recoveryStateNext = undefined;
    let state: S;
    if (recoveryState === undefined) {
      const branch = await input.currentBranch();
      state = input.hooks.createIterationState({ iteration, maxIterations: input.maxIterations, steps: stepsSnapshot, branch });
      await input.hooks.onIterationStart?.({
        state,
        iteration,
        maxIterations: input.maxIterations,
        steps: stepsSnapshot,
        startStepIndex,
        resumedPriorSteps: iteration === startIteration && firstIterationResumed,
      });
    } else {
      state = recoveryState.state;
    }

    const startedAt = Date.now();
    iterationStartedAt = startedAt;
    const resumeForThisIteration = iteration === startIteration ? firstIterationResume : undefined;
    const recoveryNudgeForThisIteration = recoveryNudgeNext;
    recoveryNudgeNext = false;

    try {
      const result = await input.runIteration({
        state,
        ...(input.control !== undefined ? { control: input.control } : {}),
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
        ...(input.unattended !== undefined ? { unattended: input.unattended } : {}),
        writeStop: input.store.writeStop,
        ...(input.useSessionIdle !== undefined ? { useSessionIdle: input.useSessionIdle } : {}),
        ...(input.prdDir !== undefined ? { prdDir: input.prdDir } : {}),
        ...(input.storyIdPattern !== undefined ? { storyIdPattern: input.storyIdPattern } : {}),
        ...(input.storyState !== undefined ? { storyState: input.storyState } : {}),
        ...(input.storyResolver !== undefined ? { storyResolver: input.storyResolver } : {}),
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
          stepsSnapshot,
          looperRunID,
          persistTitles,
          getStepSessions: () => iterationStepSessions,
          setStepSessions: (entries) => {
            iterationStepSessions = entries;
          },
          frontendHooks: input.hooks,
        }),
      });

      if (result === "stopped" || stopRequested()) {
        const reason = input.store.stopReason();
        await input.hooks.onStopRequested?.({ iteration, reason, phase: "after-iteration" });
        return { kind: "stopped", reason };
      }
      const completedAfterIteration = await stopForCompletedPrd(iteration, "after-iteration");
      if (completedAfterIteration !== undefined) return completedAfterIteration;
      if (stallObserver !== undefined) {
        const outcome = await runStallCheck({
          observer: stallObserver,
          confirmMs: input.stallConfirmMs ?? stallConfirmMs(),
          store: input.store,
          currentBranch: input.currentBranch,
          shouldAbort: stopRequested,
        });
        if (outcome.stopped) {
          await input.hooks.onStopRequested?.({ iteration, reason: outcome.reason, phase: "after-iteration" });
          return { kind: "stopped", reason: outcome.reason };
        }
      }
    } catch (error) {
      if (!(error instanceof StepFailureError) || input.hooks.onStepFailure === undefined || input.hooks.recoveryResumeForChoice === undefined) throw error;
      const choice = await input.hooks.onStepFailure({ state, error: errorToFailure(error) });
      if (choice === "quit" || stopRequested()) {
        return { kind: "stopped", reason: input.store.stopReason() };
      }
      recoveryNudgeNext = choice === "nudge";
      const recoveryRunState = input.store.read();
      const recoveryResume = input.hooks.recoveryResumeForChoice({
        choice,
        ...(error.sessionID !== undefined ? { failedSessionID: error.sessionID } : {}),
        ...(error.stepName !== undefined ? { failedStepName: error.stepName } : {}),
        runState: recoveryRunState,
      });
      firstIterationResume = recoveryResume;
      recoveryStateNext = choice === "nudge" && recoveryResume?.sessionID !== undefined ? { state } : undefined;
      const recoverySteps = stepsSnapshot;
      recoveryStepsNext = stepsSnapshot;
      const failedStepIndex = recoveryRunState !== null ? stepIndexFromRunState(recoveryRunState, recoverySteps) : input.legacyResumeStepIndex(recoverySteps);
      startIteration = iteration;
      firstIterationStartStepIndex = failedStepIndex;
      firstIterationResumed = failedStepIndex > 0;
      firstIterationTitle = persistTitles ? recoveryRunState?.title : undefined;
      iterationStepSessions = iterationStepSessions.length > 0 ? iterationStepSessions : (recoveryRunState?.stepSessions ?? []);
      looperRunID = recoveryRunState?.looperRunID ?? looperRunID;
      if (stopRequested()) return { kind: "stopped", reason: input.store.stopReason() };
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
