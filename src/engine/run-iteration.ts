import { readFileSync } from "node:fs";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { DEFAULT_STEP_TIMEOUT_MS, inheritedRenameDelayMs } from "../config/tunables.ts";
import { loadSteps, resolveContextPolicy, type ContextPolicy, type LoadedStep, type PermissionPolicy, type QuestionPolicy, type RecoverySnapshotsConfig, type TitleGenConfig } from "../lib/config.ts";
import { readPrd } from "../lib/prd.ts";
import { cleanRestartPrompt, failureRetryPrompt, recoveryNudgePrompt, backgroundContinuationPrompt, orphanedBackgroundNudgePrompt, textEndsWithNewline } from "../core/prompt-builders.ts";
import { decideResume, type ResumeWorkState } from "../core/resume-policy.ts";
import { MAX_FAILURE_RETRIES_PER_STEP, MAX_REATTACH_PER_STEP, nextActionForBackgroundResume, nextActionForFailure, nextActionForOrphanedBackgroundNudge, shouldEvaluatePriorSessionForReattach } from "../core/retry-policy.ts";
import type { TitleService } from "./engine-ports.ts";
import { TitleCoordinator, titleModeFor } from "./title-coordinator.ts";
import { fetchPromptVcsDelta } from "../watchers/branch-delta.ts";
export { FALLBACK_BASE_BRANCHES, MAINLINE_BRANCH_NAMES, isMainlineRef, commitsAheadOfRef, normalizeGitStatusCode, parseNumstatZ, parseNameStatusZ, branchDeltaChangedFiles, resolveBranchDelta, fetchBranchDelta, fetchPromptVcsDelta } from "../watchers/branch-delta.ts";
export type { BranchDelta, BranchDeltaChange } from "../watchers/branch-delta.ts";
import { buildLooperContext, withLooperContext, type ContextInput, type PriorStepInfo } from "../lib/prompt-context.ts";
import { latestUserMessageID } from "../opencode/assistant-classification.ts";
import {
  evaluatePriorSession,
  reattachOpenCodeStep,
  resumeSessionWorkState,
  runOpenCodeStep,
  sessionPendingState,
  stopServerSession,
  waitForSessionHealth,
  waitForLoopContinuationIdle,
  type Step,
  type StepResult,
  type StepRunResult,
  type SessionHealthState,
} from "../lib/runner.ts";
import { createStepRow, failStepRow, insertFailureRetryAttempt, insertRestartAttempt, notify, pushAgentLine, pushStepOutputLine, resetStepRowToPending, setStepLooperMessageIDs, setStepPromptText, type LoopState, type LoopStep, type StepRestartReason } from "../lib/state.ts";
import { stopAfterIterationFileExists, stopFileExists } from "../lib/state-files.ts";
import { extractAssistantModel, extractAssistantText, generateWorkDescription, humanizeBranchName, setSessionTitle } from "../lib/title.ts";
import {
  decideRouting,
  insertAdjudicationRow,
  recordStepTransitions,
  snapshotPrd,
  withAdjudicationReason,
  type AdjudicationRuntime,
} from "./adjudication-routing.ts";

const titleService: TitleService = {
  humanizeBranchName,
  extractAssistantText,
  extractAssistantModel,
  generateWorkDescription,
};

function fileReadMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function promptText(step: Step): string {
  let prompt: string;
  try {
    prompt = readFileSync(step.prompt, "utf8");
  } catch (error) {
    if (fileReadMissing(error)) throw new Error(`missing prompt file for ${step.name}: ${step.prompt}`);
    throw error;
  }

  const parts: string[] = [];
  if (step.prefix) {
    parts.push(step.prefix);
    parts.push(textEndsWithNewline(step.prefix) ? "\n" : "\n\n");
  }

  parts.push(prompt);

  if (step.suffix) {
    parts.push(prompt.length === 0 || textEndsWithNewline(prompt) ? "\n" : "\n\n");
    parts.push(step.suffix);
    if (!textEndsWithNewline(step.suffix)) parts.push("\n");
  }

  return parts.join("");
}

function syncStepsUiState(
  state: LoopState,
  cfgSteps: Step[],
  nextIndex: number,
  completed: LoopStep[],
  priorStatus: "skipped" | "done" = "skipped",
): void {
  const rows: LoopStep[] = completed.map((step) => ({ ...step }));
  if (rows.length === 0 && nextIndex > 0) {
    for (let j = 0; j < nextIndex; j += 1) {
      const step = cfgSteps[j];
      if (!step) continue;
      rows.push(createStepRow(step.name, { status: priorStatus, finishedAt: Date.now() }));
    }
  }
  for (let j = nextIndex; j < cfgSteps.length; j += 1) {
    const step = cfgSteps[j];
    if (!step) continue;
    rows.push(createStepRow(step.name));
  }
  state.steps = rows;
  notify();
}

function markRemainingSkipped(state: LoopState, fromIndex: number): void {
  for (let j = fromIndex; j < state.steps.length; j += 1) {
    const row = state.steps[j];
    if (!row) continue;
    row.status = "skipped";
    row.finishedAt = Date.now();
  }
  notify();
}

export type RunIterationHooks = {
  onStepBegin?: (info: { step: Step; index: number; totalSteps: number; iteration: number; title?: string }) => void;
  onStepFinish?: (info: { step: Step; index: number; nextIndex: number; totalSteps: number; iteration: number; status: StepResult; title?: string }) => void;
  onStepSession?: (info: { iteration: number; index: number; stepName: string; sessionID: string; messageID: string; promptText?: string; looperMessageIDs?: string[]; title?: string }) => void;
  onAdjudicationRoute?: (info: { iteration: number; totalSteps: number }) => void;
};

export type ResumeSession = {
  sessionID?: string;
  messageID?: string;
  stepName?: string;
  promptText?: string;
  looperMessageIDs?: string[];
};

export type RunIterationOptions = {
  state: LoopState;
  iteration: number;
  client: OpencodeClient;
  repoDir: string;
  configDir: string;
  startStepIndex?: number;
  resume?: ResumeSession;
  recoveryNudge?: boolean;
  hooks?: RunIterationHooks;
  titleGenConfig?: TitleGenConfig;
  /**
   * When resuming a partially-completed iteration, the steps before
   * `startStepIndex` were already finished in the prior run, so render them as
   * `done` rather than the default `skipped` used for a manual mid-run start.
   */
  resumedPriorSteps?: boolean;
  /**
   * Title generated earlier in this iteration by a prior run, recovered from
   * the resume pointer. Seeds `workDescription` so steps that only inherit the
   * title (no own `title:` config) still apply it to their fresh sessions
   * instead of letting opencode auto-title from the prompt.
   */
  initialWorkDescription?: string;
  looperRunID?: string;
  recoverySnapshots?: RecoverySnapshotsConfig;
  permissionPolicy?: PermissionPolicy;
  questionPolicy?: QuestionPolicy;
  useSessionIdle?: boolean;
  prdDir?: string;
  adjudication?: AdjudicationRuntime;
  /**
   * Total configured iteration budget for the "iteration N of M" line in the
   * `<looper-context>` prompt block (see prompt-context.ts). Falls back to
   * `state.maxIterations` when omitted, so existing callers that don't pass
   * it keep working unchanged.
   */
  maxIterations?: number;
  /** Global `context:` policy resolved from RuntimeConfig; per-step `contextPolicy` overrides it. Both default to all-true when omitted (see resolveContextPolicy in config.ts). */
  contextPolicy?: Partial<ContextPolicy>;
  /**
   * Iteration-scoped opencode session ids for logical steps that finished
   * BEFORE `startStepIndex` in a prior run of this same iteration (persisted
   * via `.looper-run.json`'s `stepSessions` field). Seeds the
   * `<looper-context>` prior-steps ledger on a mid-iteration resume; entries
   * whose `stepIndex` is `>= startStepIndex` (the about-to-run/in-flight
   * step) are ignored so a crash-mid-step can't leak its own session back to
   * itself as a "prior step".
   */
  resumedStepSessions?: { stepIndex: number; stepName: string; sessionID: string }[];
};

async function waitWhilePaused(state: LoopState): Promise<void> {
  while (state.paused && !state.quitting && !stopFileExists()) {
    await Bun.sleep(100);
  }
}

/**
 * Shorter confirm-stop budget used when the loop is quitting / a stop file is
 * present, so Ctrl-C does not feel hung waiting for opencode to confirm an
 * abort before we tear down.
 */
const STOP_SESSION_QUIT_TIMEOUT_MS = 1_500;
async function sleepInterruptible(state: LoopState, totalMs: number): Promise<void> {
  const step = 100;
  let remaining = totalMs;
  while (remaining > 0) {
    if (state.quitting || stopFileExists() || state.skipRequested || state.restartRequested) return;
    const slice = Math.min(step, remaining);
    await Bun.sleep(slice);
    remaining -= slice;
  }
}

export class StepFailureError extends Error {
  readonly stepName?: string;
  readonly sessionID?: string;
  constructor(message: string, info?: { stepName?: string; sessionID?: string }) {
    super(message);
    this.name = "StepFailureError";
    if (info?.stepName !== undefined) this.stepName = info.stepName;
    if (info?.sessionID !== undefined) this.sessionID = info.sessionID;
  }
}

export async function runIteration(options: RunIterationOptions): Promise<"complete" | "stopped"> {
  const {
    state,
    iteration,
    client,
    repoDir,
    configDir,
    startStepIndex = 0,
    resume,
    recoveryNudge = false,
    hooks,
    titleGenConfig,
    resumedPriorSteps = false,
    initialWorkDescription,
    looperRunID,
    recoverySnapshots = false,
    permissionPolicy,
    questionPolicy,
    useSessionIdle,
    prdDir,
    adjudication,
    maxIterations,
    contextPolicy: globalContextPolicy,
    resumedStepSessions,
  } = options;
  const completed: LoopStep[] = [];
  // Logical-step ledger for the `<looper-context>` prior-steps section, keyed
  // by `stepIndex` (config position; immune to duplicate step names) rather
  // than row position in `state.steps` or dedupe-by-name like `completed`
  // above (which is left untouched and keeps driving existing UI rendering).
  // Exactly one entry is pushed per logical step, only once its retry/restart
  // loop has fully resolved, so a step's own attempts never show up here as a
  // distinct prior step.
  const completedLogicalSteps: { stepIndex: number; name: string; status: StepResult; sessionID?: string }[] = [];
  if (resumedStepSessions !== undefined) {
    const seeded = [...resumedStepSessions].filter((entry) => entry.stepIndex < startStepIndex).sort((a, b) => a.stepIndex - b.stepIndex);
    for (const entry of seeded) {
      completedLogicalSteps.push({ stepIndex: entry.stepIndex, name: entry.stepName, status: "done", sessionID: entry.sessionID });
    }
  }
  let index = Math.max(0, startStepIndex);
  let startStepIndexApplied = false;
  let recoveryNudgePending = recoveryNudge;
  let workDescription: string | undefined = initialWorkDescription;
  let pendingResume: ResumeSession | undefined = resume?.sessionID !== undefined ? resume : undefined;
  let pendingAdjudicateStep: LoadedStep | undefined;
  let initialRoutingChecked = false;

  /**
   * Confirm a server session is actually stopped before we create a fresh one
   * or resume a different one. A client-side request abort never stops
   * opencode's server-side generation; without this a retry/restart can leave
   * the prior session running while a new one starts (two concurrent runs).
   */
  const logStepLine = (stepIdx: number, line: string): void => {
    pushAgentLine(state, line);
    pushStepOutputLine(state, stepIdx, line);
    notify();
  };

  const logRecoveryBoundary = (stepIdx: number, action: "retry" | "restart" | "skip", sessionID: string | undefined, messageID: string | undefined): void => {
    if (recoverySnapshots === false) return;
    if (action === "skip" && recoverySnapshots !== "before-retry-and-skip") return;
    if (sessionID === undefined && messageID === undefined) return;
    const session = sessionID === undefined ? "session=unavailable" : `session=${sessionID}`;
    const message = messageID === undefined ? "message=unavailable" : `message=${messageID}`;
    logStepLine(stepIdx, `[looper] recovery snapshot boundary before ${action}: ${session} ${message} (no file changes reverted)`);
  };

  const stopPriorSession = async (sessionID: string | undefined, stepIdx: number, timeoutMs?: number): Promise<boolean> => {
    if (sessionID === undefined) return true;
    return await stopServerSession({
      client,
      repoDir,
      sessionID,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      log: (line) => logStepLine(stepIdx, line),
    });
  };

  while (true) {
    const steps = loadSteps(configDir);
    if (steps.length === 0) throw new Error("loop.yaml must define at least one step");
    if (!startStepIndexApplied) {
      index = Math.min(index, steps.length - 1);
      startStepIndexApplied = true;
    }

    if (!initialRoutingChecked) {
      initialRoutingChecked = true;
      const initialRouting = decideRouting(adjudication);
      if (initialRouting.kind !== "continue") {
        const resumedSessionID = pendingResume?.sessionID;
        if (resumedSessionID !== undefined) {
          const resumedStepName = pendingResume?.stepName ?? steps[index]?.name ?? "resumed step";
          if (!(await stopPriorSession(resumedSessionID, index))) {
            throw new StepFailureError(
              `could not confirm session ${resumedSessionID} stopped; deferring adjudication to avoid overlapping opencode generations`,
              { stepName: resumedStepName, sessionID: resumedSessionID },
            );
          }
          pendingResume = undefined;
        }
        // A prior run may have crashed mid-adjudication after dispatching the
        // adjudicator prompt. Confirm that recorded session is stopped before
        // launching a fresh adjudicator so the two generations can't overlap.
        const orphanedAdjudicator = adjudication?.store.readSession();
        if (orphanedAdjudicator != null) {
          const adjName = initialRouting.kind === "adjudicate" ? initialRouting.step.name : "adjudicate";
          if (!(await stopPriorSession(orphanedAdjudicator.sessionID, index))) {
            throw new StepFailureError(
              `could not confirm adjudicator session ${orphanedAdjudicator.sessionID} stopped; deferring adjudication to avoid overlapping opencode generations`,
              { stepName: adjName, sessionID: orphanedAdjudicator.sessionID },
            );
          }
          adjudication?.store.clearSession();
        }
        syncStepsUiState(state, steps, index, completed, resumedPriorSteps ? "done" : "skipped");
        const firstRemainingRow = state.steps.length - (steps.length - index);
        markRemainingSkipped(state, firstRemainingRow);
        hooks?.onAdjudicationRoute?.({ iteration, totalSteps: steps.length });
        if (initialRouting.kind === "stop") {
          adjudication?.writeStop(initialRouting.reason);
          adjudication?.store.clearMarker();
          break;
        }
        pendingAdjudicateStep = initialRouting.step;
        insertAdjudicationRow(state, initialRouting.step.name);
      }
    }

    const adjudicating = pendingAdjudicateStep !== undefined;
    if (!adjudicating && index >= steps.length) break;

    if (!adjudicating) syncStepsUiState(state, steps, index, completed, resumedPriorSteps ? "done" : "skipped");
    let currentStepIndex = adjudicating ? state.steps.length - 1 : state.steps.length - (steps.length - index);

    if (stopFileExists() || state.quitting) {
      markRemainingSkipped(state, currentStepIndex);
      break;
    }

    await waitWhilePaused(state);

    if (stopFileExists() || state.quitting) {
      markRemainingSkipped(state, currentStepIndex);
      break;
    }

    const configuredStep = steps[index];
    if (pendingAdjudicateStep === undefined && configuredStep === undefined) break;
    const step = pendingAdjudicateStep ?? configuredStep;
    if (step === undefined) break;
    const executionIndex = adjudicating ? steps.length : index;
    const executionTotalSteps = adjudicating ? steps.length + 1 : steps.length;
    if (!adjudicating) hooks?.onStepBegin?.({ step, index, totalSteps: steps.length, iteration, ...(workDescription !== undefined ? { title: workDescription } : {}) });
    const prdBefore = snapshotPrd(adjudication, prdDir);
    const stepSessionMetadata = looperRunID === undefined
      ? undefined
      : {
          looperRunID,
          iteration,
          stepIndex: executionIndex,
          stepName: step.name,
          configDir,
          repoDir,
          purpose: "step" as const,
        };

    const titleConfig = step.title;
    let stepIndexForTitle = currentStepIndex;
    const titleLog = (line: string) => {
      pushAgentLine(state, line);
      pushStepOutputLine(state, stepIndexForTitle, line);
      notify();
    };

    /**
     * Apply a generated title to (a) the TUI row's `title` field and (b) the
     * opencode session via `session.update`. Idempotent on state; the opencode
     * call is skipped when sessionID is not yet bound (e.g., called from the
     * eager step-start path of a reuse step before the session exists). Also
     * mutates the outer `workDescription` so later steps inherit the value.
     */
    const applyTitle = async (desc: string, targetSessionID?: string): Promise<void> => {
      workDescription = desc;
      const row = state.steps[stepIndexForTitle];
      if (row && row.title !== desc) {
        row.title = desc;
        notify();
      }
      const sid = targetSessionID ?? state.steps[stepIndexForTitle]?.sessionID;
      if (sid === undefined) return;
      await setSessionTitle({
        client,
        repoDir,
        sessionID: sid,
        title: `${step.name}: ${desc}`,
        log: titleLog,
      });
    };

    const titleMode = titleConfig === undefined ? undefined : titleModeFor(titleConfig);
    const titleCoordinator =
      titleMode === undefined
        ? undefined
        : new TitleCoordinator(
            client,
            repoDir,
            titleMode,
            titleService,
            () => state.steps[stepIndexForTitle]?.sessionID,
            () => state.branch,
            applyTitle,
            titleLog,
            titleGenConfig,
            stepSessionMetadata,
          );

    // Step has no own title config but the iteration already has a description
    // from a previous step (typical: build sets it, review/cleanup/push inherit).
    // Apply the TUI side immediately so the output-box header shows the title
    // from the first frame of this step; defer the opencode session.update
    // until N ms after the first assistant response (see
    // inheritedRenameDelayMs) so opencode doesn't auto-title from the prompt
    // and the rename doesn't race the session-create. Step end is the
    // fallback if no first response is seen.
    const usingInheritedTitle = titleCoordinator === undefined && workDescription !== undefined;
    // Track the session the inherited title was last written to (not a boolean
    // latch): a retry/timeout/restart swaps in a fresh session, and the title
    // must follow to the new session rather than staying on the abandoned one.
    let inheritedTitleAppliedSessionID: string | undefined;
    let inheritedTitleTimer: ReturnType<typeof setTimeout> | undefined;
    let inheritedTitleInflight: Promise<void> | undefined;
    const applyInheritedOpencodeTitle = async (): Promise<void> => {
      const sid = state.steps[stepIndexForTitle]?.sessionID;
      if (sid === undefined || workDescription === undefined) return;
      if (inheritedTitleAppliedSessionID === sid) return;
      inheritedTitleAppliedSessionID = sid;
      await setSessionTitle({
        client,
        repoDir,
        sessionID: sid,
        title: `${step.name}: ${workDescription}`,
        log: titleLog,
      });
    };
    const onInheritedFirstResponse = (): void => {
      if (inheritedTitleTimer !== undefined) return;
      const sid = state.steps[stepIndexForTitle]?.sessionID;
      if (sid !== undefined && inheritedTitleAppliedSessionID === sid) return;
      inheritedTitleTimer = setTimeout(() => {
        inheritedTitleTimer = undefined;
        if (inheritedTitleInflight === undefined) inheritedTitleInflight = startInheritedTitleApply();
      }, inheritedRenameDelayMs());
    };
    const cancelInheritedTitleTimer = (): void => {
      if (inheritedTitleTimer !== undefined) {
        clearTimeout(inheritedTitleTimer);
        inheritedTitleTimer = undefined;
      }
    };
    const startInheritedTitleApply = (): Promise<void> => {
      inheritedTitleInflight = applyInheritedOpencodeTitle()
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          try {
            titleLog(`[looper] inherited title apply threw: ${message}`);
          } catch {
            return;
          }
        })
        .finally(() => {
          cancelInheritedTitleTimer();
          inheritedTitleInflight = undefined;
        });
      return inheritedTitleInflight;
    };
    if (usingInheritedTitle) {
      const row = state.steps[stepIndexForTitle];
      if (row && row.title !== workDescription) {
        row.title = workDescription;
        notify();
      }
    }

    let result: StepRunResult;
    let pendingResult: StepRunResult | undefined;
    let suppressFailureRetry = false;
    let suppressReason: string | undefined;
    let allowTerminalSessionToContinue = false;
    let failureRetryCount = 0;
    let reattachCount = 0;
    let resumeSessionID: string | undefined;
    let resumePrompt: string | undefined;
    let recoveryNudgeActive = false;
    if (recoveryNudgePending) {
      recoveryNudgePending = false;
      recoveryNudgeActive = true;
      resumePrompt = recoveryNudgePrompt(promptText(step));
    }
    let backgroundResumeCount = 0;
    let orphanNudgeCount = 0;
    let lastErrorMessage: string | undefined;
    let lastPromptMessageID: string | undefined;
    const budgetMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    let stepStartTime = Date.now();
    const failAfterUnconfirmedStop = (sessionID: string, stepIdx: number, action: string): StepRunResult => {
      const reason = `could not confirm session ${sessionID} stopped; not ${action} to avoid overlapping opencode generations`;
      suppressFailureRetry = true;
      suppressReason = reason;
      lastErrorMessage = reason;
      logStepLine(stepIdx, `[looper] ${reason}`);
      failStepRow(state, stepIdx, "failed");
      return { status: "failed", sessionID, errorMessage: reason };
    };
    const failAfterUnrecoveredServer = (sessionID: string, stepIdx: number): StepRunResult => {
      const reason = `server did not recover while checking session ${sessionID}; leaving the session alone so it can complete in the background`;
      suppressFailureRetry = true;
      suppressReason = reason;
      allowTerminalSessionToContinue = true;
      lastErrorMessage = reason;
      logStepLine(stepIdx, `[looper] ${reason}`);
      failStepRow(state, stepIdx, "failed");
      return { status: "failed", sessionID, errorMessage: reason };
    };
    const failAfterActivePriorSession = (sessionID: string, stepIdx: number, reason: string): StepRunResult => {
      suppressFailureRetry = true;
      suppressReason = reason;
      allowTerminalSessionToContinue = true;
      lastErrorMessage = reason;
      logStepLine(stepIdx, `[looper] ${reason}; leaving session ${sessionID} alone so it can complete`);
      failStepRow(state, stepIdx, "failed");
      return { status: "failed", sessionID, errorMessage: reason };
    };
    const stopAfterInterruptedHealthWait = (sessionID: string, stepIdx: number): StepRunResult => {
      if (state.restartRequested) {
        const reason = state.restartReason ?? "manual";
        logStepLine(stepIdx, `[looper] server health check stopped by ${reason} restart request for session ${sessionID}`);
        return { status: "restart", sessionID, restartReason: reason };
      }
      if (state.quitting || stopFileExists()) {
        const reason = `stop requested while checking session ${sessionID}`;
        lastErrorMessage = reason;
        logStepLine(stepIdx, `[looper] ${reason}`);
        failStepRow(state, stepIdx, "failed");
        return { status: "failed", sessionID, errorMessage: reason };
      }
      logStepLine(stepIdx, `[looper] server health check stopped for session ${sessionID}`);
      failStepRow(state, stepIdx, "skipped");
      return { status: "skipped", sessionID };
    };

    const waitForRecoverableHealth = async (sessionID: string, stepIdx: number): Promise<SessionHealthState> =>
      await waitForSessionHealth({
        client,
        repoDir,
        sessionID,
        log: (line) => logStepLine(stepIdx, line),
        shouldStop: () => state.quitting || stopFileExists() || state.skipRequested || state.restartRequested,
      });

    if (pendingResume !== undefined) {
      const resumeInfo = pendingResume;
      pendingResume = undefined;
      const resumeSession = resumeInfo.sessionID;
      if (resumeSession !== undefined) {
        const stepMatches = resumeInfo.stepName === undefined || resumeInfo.stepName === step.name;
        let workState: ResumeWorkState = await resumeSessionWorkState({ client, repoDir, sessionID: resumeSession, staleBusyThresholdMs: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS });
        if (stepMatches && workState === "unknown") {
          const recovered = await waitForRecoverableHealth(resumeSession, currentStepIndex);
          if (recovered === "stopped") {
            pendingResult = stopAfterInterruptedHealthWait(resumeSession, currentStepIndex);
          } else {
            workState = recovered === "pending" ? "running" : recovered;
          }
        }
        if (pendingResult === undefined) {
          const resumeDecision = decideResume({
            currentStepName: step.name,
            recordedStepName: resumeInfo.stepName,
            workState,
            messageID: resumeInfo.messageID,
            recoveryNudgeActive,
          });
          if (resumeDecision.kind === "reattach" && resumeInfo.messageID !== undefined) {
            logStepLine(currentStepIndex, `[looper] resuming ${step.name}: session ${resumeSession} still active; reattaching`);
            lastPromptMessageID = resumeInfo.messageID;
            // onStepBegin's saveRunStatePosition just cleared the live session ids
            // from .looper-run.json, and reattach never hits runOpenCodeStep's
            // onSessionBound; re-persist them so a crash mid-reattach can still
            // reattach instead of starting a fresh overlapping generation.
            if (!adjudicating) {
              hooks?.onStepSession?.({
                iteration,
                index: executionIndex,
                stepName: step.name,
                sessionID: resumeSession,
                messageID: resumeInfo.messageID,
                ...(resumeInfo.promptText !== undefined ? { promptText: resumeInfo.promptText } : {}),
                ...(resumeInfo.looperMessageIDs !== undefined ? { looperMessageIDs: [...resumeInfo.looperMessageIDs] } : {}),
                ...(workDescription !== undefined ? { title: workDescription } : {}),
              });
            }
            pendingResult = await reattachOpenCodeStep({
              state,
              stepIndex: currentStepIndex,
              client,
              repoDir,
              step,
              sessionID: resumeSession,
              outcomeMessageID: resumeInfo.messageID,
              ...(resumeInfo.promptText !== undefined ? { promptText: resumeInfo.promptText } : {}),
              ...(resumeInfo.looperMessageIDs !== undefined ? { looperMessageIDs: resumeInfo.looperMessageIDs } : {}),
              timeoutMsOverride: Math.max(0, budgetMs - (Date.now() - stepStartTime)),
              ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
              ...(questionPolicy !== undefined ? { questionPolicy } : {}),
              ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
            });
          } else if (resumeDecision.kind === "nudge-existing") {
            logStepLine(currentStepIndex, `[looper] resuming ${step.name}: prior session ${resumeSession} is idle; nudging the existing session`);
            resumeSessionID = resumeSession;
            if (resumeInfo.promptText !== undefined) setStepPromptText(state, currentStepIndex, resumeInfo.promptText);
            setStepLooperMessageIDs(
              state,
              currentStepIndex,
              resumeInfo.looperMessageIDs ?? (resumeInfo.messageID !== undefined ? [resumeInfo.messageID] : []),
            );
          } else if (resumeDecision.kind === "restart-fresh") {
            logStepLine(currentStepIndex, `[looper] resuming ${step.name}: prior session ${resumeSession} is idle; restarting step in a fresh session`);
          } else if (resumeDecision.kind === "fail-closed") {
            if (resumeDecision.cause === "unrecovered-server") {
              pendingResult = failAfterUnrecoveredServer(resumeSession, currentStepIndex);
            } else {
              logStepLine(currentStepIndex, `[looper] resuming ${step.name}: ${resumeDecision.reason}; confirming session ${resumeSession} is stopped before restarting`);
              if (!(await stopPriorSession(resumeSession, currentStepIndex))) {
                pendingResult = failAfterUnconfirmedStop(resumeSession, currentStepIndex, "restarting after resume");
              }
            }
          }
        }
      }
    }

    while (true) {
      if (pendingResult !== undefined) {
        result = pendingResult;
        pendingResult = undefined;
      } else {
        const stepContextPolicy = resolveContextPolicy(step, { contextPolicy: globalContextPolicy });
        const priorSteps: PriorStepInfo[] = completedLogicalSteps.map((entry) => ({
          name: entry.name,
          status: entry.status,
          ...(entry.sessionID !== undefined ? { sessionID: entry.sessionID } : {}),
        }));
        const vcs = stepContextPolicy.vcsDelta
          ? await fetchPromptVcsDelta(client, repoDir, state.branch || undefined, (line) => logStepLine(currentStepIndex, line))
          : undefined;
        const prdResult = stepContextPolicy.prd && prdDir !== undefined ? readPrd(prdDir) : undefined;
        const prd = prdResult?.kind === "ok" ? { remaining: prdResult.remaining, total: prdResult.total } : undefined;
        const contextInput: ContextInput = {
          now: new Date(),
          repoDir,
          iteration,
          maxIterations: maxIterations ?? state.maxIterations,
          stepName: step.name,
          stepIndex: executionIndex,
          totalSteps: executionTotalSteps,
          priorSteps,
          timeoutMs: budgetMs,
          ...(prd !== undefined ? { prd } : {}),
          ...(vcs !== undefined ? { vcs } : {}),
        };
        const contextBlock = buildLooperContext(stepContextPolicy, contextInput);
        const stepBasePrompt = adjudicating
          ? withAdjudicationReason(promptText(step), adjudication?.store.readMarker() ?? null)
          : promptText(step);
        result = await runOpenCodeStep({
          state,
          stepIndex: currentStepIndex,
          prompt: withLooperContext(contextBlock, resumePrompt ?? stepBasePrompt),
          client,
          repoDir,
          step,
          sessionID: resumeSessionID,
          timeoutMsOverride: Math.max(0, budgetMs - (Date.now() - stepStartTime)),
          ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
          ...(questionPolicy !== undefined ? { questionPolicy } : {}),
          ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
          ...(stepSessionMetadata !== undefined ? { sessionMetadata: stepSessionMetadata } : {}),
          onSessionBound: ({ sessionID, messageID, promptText: sentPromptText, looperMessageIDs }) => {
            if (adjudicating) {
              adjudication?.store.writeSession({ sessionID, messageID });
              return;
            }
            hooks?.onStepSession?.({ iteration, index, stepName: step.name, sessionID, messageID, promptText: sentPromptText, looperMessageIDs: [...looperMessageIDs], ...(workDescription !== undefined ? { title: workDescription } : {}) });
          },
          ...(titleCoordinator
            ? { onFirstAssistantContent: titleCoordinator.onFirstResponse }
            : usingInheritedTitle
              ? { onFirstAssistantContent: onInheritedFirstResponse }
              : {}),
        });
      }
      resumePrompt = undefined;
      const requestedRestartReason = state.restartReason;
      state.skipRequested = false;
      state.restartRequested = false;
      state.restartReason = undefined;
      notify();

      if (result.messageID !== undefined) lastPromptMessageID = result.messageID;
      if (result.status === "failed" && result.errorMessage) {
        lastErrorMessage = result.errorMessage;
      }

      if (result.status === "waiting" && result.sessionID !== undefined) {
        const waitSessionID = result.sessionID;
        backgroundResumeCount += 1;
        const backgroundResumeDecision = nextActionForBackgroundResume(backgroundResumeCount);
        if (backgroundResumeDecision.kind === "fail") {
          result = { status: "failed" };
          suppressFailureRetry = true;
          suppressReason = `${backgroundResumeDecision.reason} for session ${waitSessionID}`;
          lastErrorMessage = lastErrorMessage ?? suppressReason;
          const line = `[looper] background task resume limit exceeded for session ${waitSessionID}`;
          pushAgentLine(state, line);
          pushStepOutputLine(state, currentStepIndex, line);
          failStepRow(state, currentStepIndex, "failed");
          break;
        }

        const remainingMs = Math.max(0, budgetMs - (Date.now() - stepStartTime));
        const waitResult = await waitForLoopContinuationIdle({ state, client, stepIndex: currentStepIndex, repoDir, sessionID: waitSessionID, timeoutMs: remainingMs });
        if (waitResult === "idle" && !state.quitting && !stopFileExists()) {
          resumeSessionID = waitSessionID;
          resumePrompt = backgroundContinuationPrompt();
          pushAgentLine(state, `[looper] background tasks idle; resuming session ${resumeSessionID}`);
          pushStepOutputLine(state, currentStepIndex, `[looper] background tasks idle; resuming session ${resumeSessionID}`);
          notify();
          continue;
        }

        if (waitResult === "resumed" && !state.quitting && !stopFileExists()) {
          // Track the continuation hook's own user message so the resumed
          // turn's outcome decides the step result; classifying against
          // lastPromptMessageID would grade the already-completed prior turn.
          const resumedMessageID = (await latestUserMessageID(client, repoDir, waitSessionID)) ?? lastPromptMessageID;
          if (resumedMessageID !== undefined) {
            const activeStep = state.steps[currentStepIndex];
            if (!adjudicating) {
              hooks?.onStepSession?.({
                iteration,
                index,
                stepName: step.name,
                sessionID: waitSessionID,
                messageID: resumedMessageID,
                ...(activeStep?.promptText !== undefined ? { promptText: activeStep.promptText } : {}),
                ...(activeStep?.looperMessageIDs !== undefined ? { looperMessageIDs: [...activeStep.looperMessageIDs] } : {}),
                ...(workDescription !== undefined ? { title: workDescription } : {}),
              });
            }
            const line = `[looper] session ${waitSessionID} resumed by opencode after background tasks; reattaching to stream its output`;
            pushAgentLine(state, line);
            pushStepOutputLine(state, currentStepIndex, line);
            notify();
            pendingResult = await reattachOpenCodeStep({
              state,
              stepIndex: currentStepIndex,
              client,
              repoDir,
              step,
              sessionID: waitSessionID,
              outcomeMessageID: resumedMessageID,
              timeoutMsOverride: Math.max(0, budgetMs - (Date.now() - stepStartTime)),
              ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
              ...(questionPolicy !== undefined ? { questionPolicy } : {}),
              ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
            });
            continue;
          }
        }

        if (waitResult === "orphaned" && !state.quitting && !stopFileExists()) {
          orphanNudgeCount += 1;
          const orphanNudgeDecision = nextActionForOrphanedBackgroundNudge(orphanNudgeCount);
          if (orphanNudgeDecision.kind === "fail") {
            result = { status: "failed" };
            suppressFailureRetry = true;
            suppressReason = `${orphanNudgeDecision.reason} for session ${waitSessionID}`;
            lastErrorMessage = lastErrorMessage ?? suppressReason;
            const line = `[looper] background marker still orphaned after nudge; failing closed for session ${waitSessionID}`;
            pushAgentLine(state, line);
            pushStepOutputLine(state, currentStepIndex, line);
            failStepRow(state, currentStepIndex, "failed");
            break;
          }
          resumeSessionID = waitSessionID;
          resumePrompt = orphanedBackgroundNudgePrompt();
          pushAgentLine(state, `[looper] background marker orphaned; nudging session ${resumeSessionID} to verify and finish`);
          pushStepOutputLine(state, currentStepIndex, `[looper] background marker orphaned; nudging session ${resumeSessionID} to verify and finish`);
          notify();
          continue;
        }

        if (waitResult === "restart") {
          const reason: StepRestartReason = state.restartReason ?? "manual";
          const previousStepIndex = currentStepIndex;
          if (!(await stopPriorSession(waitSessionID, previousStepIndex))) {
            result = failAfterUnconfirmedStop(waitSessionID, previousStepIndex, "starting a restart session");
            break;
          }
          currentStepIndex = insertRestartAttempt(state, currentStepIndex, reason);
          stepIndexForTitle = currentStepIndex;
          stepStartTime = Date.now();
          resumeSessionID = undefined;
          resumePrompt = cleanRestartPrompt(promptText(step), reason);
          pushAgentLine(state, `[looper] restart requested during background wait for session ${waitSessionID}`);
          pushStepOutputLine(state, previousStepIndex, `[looper] restart requested during background wait for session ${waitSessionID}`);
          state.restartRequested = false;
          state.restartReason = undefined;
          resetStepRowToPending(state, currentStepIndex);
          continue;
        }

        if (waitResult === "timeout") {
          const previousStepIndex = currentStepIndex;
          if (!(await stopPriorSession(waitSessionID, previousStepIndex))) {
            result = failAfterUnconfirmedStop(waitSessionID, previousStepIndex, "starting a timeout restart session");
            break;
          }
          currentStepIndex = insertRestartAttempt(state, currentStepIndex, "timeout");
          stepIndexForTitle = currentStepIndex;
          stepStartTime = Date.now();
          resumeSessionID = undefined;
          resumePrompt = cleanRestartPrompt(promptText(step), "timeout");
          pushAgentLine(state, `[looper] timeout restarting ${step.name} after background wait for session ${waitSessionID}`);
          pushStepOutputLine(state, previousStepIndex, `[looper] timeout restarting ${step.name} after background wait for session ${waitSessionID}`);
          resetStepRowToPending(state, currentStepIndex);
          continue;
        }

        const skipLike = waitResult === "stopped" || waitResult === "skipped";
        result = { status: skipLike ? "skipped" : "failed" };
        if (!skipLike) {
          suppressFailureRetry = true;
          suppressReason = `background task wait ended with ${waitResult} for session ${waitSessionID}`;
          lastErrorMessage = lastErrorMessage ?? suppressReason;
        }
        failStepRow(state, currentStepIndex, result.status === "skipped" ? "skipped" : "failed");
        pushAgentLine(state, `[looper] background task wait ended with ${waitResult} for session ${waitSessionID}`);
        pushStepOutputLine(state, currentStepIndex, `[looper] background task wait ended with ${waitResult} for session ${waitSessionID}`);
        notify();
      }

      if (result.status === "restart" && !state.quitting && !stopFileExists()) {
        const reason = result.restartReason ?? requestedRestartReason ?? "manual";
        const priorSessionID = result.sessionID ?? state.steps[currentStepIndex]?.sessionID;
        logRecoveryBoundary(currentStepIndex, "restart", priorSessionID, lastPromptMessageID);
        // Confirm the prior session is actually aborted before creating the
        // fresh restart session, so the old run can't keep generating in
        // parallel with the new one.
        if (!(await stopPriorSession(priorSessionID, currentStepIndex)) && priorSessionID !== undefined) {
          result = failAfterUnconfirmedStop(priorSessionID, currentStepIndex, "starting a restart session");
          break;
        }
        currentStepIndex = insertRestartAttempt(state, currentStepIndex, reason);
        stepIndexForTitle = currentStepIndex;
        stepStartTime = Date.now();
        resumeSessionID = undefined;
        resumePrompt = cleanRestartPrompt(promptText(step), reason);
        continue;
      }

      if (result.status === "failed") {
        const errReason = lastErrorMessage ?? "unknown error (no message reported)";
        const stopRequested = state.quitting || stopFileExists();
        const failureDecision = nextActionForFailure({ failureRetryCount, suppressFailureRetry, ...(suppressReason !== undefined ? { suppressReason } : {}), stopRequested });

        if (failureDecision.kind === "fail") {
          const skipReason = failureDecision.reason;
          logRecoveryBoundary(currentStepIndex, "skip", state.steps[currentStepIndex]?.sessionID, lastPromptMessageID);
          const line = `[looper] ${step.name} failed: ${errReason} \u2014 not retrying: ${skipReason}`;
          pushAgentLine(state, line);
          pushStepOutputLine(state, currentStepIndex, line);
          notify();
          break;
        }

        const priorSessionForCheck = state.steps[currentStepIndex]?.sessionID;
        if (
          priorSessionForCheck !== undefined &&
          lastPromptMessageID !== undefined
        ) {
          let ev = await evaluatePriorSession({
            client,
            repoDir,
            sessionID: priorSessionForCheck,
            messageID: lastPromptMessageID,
          });
          if (!ev.statusKnown && ev.classification.kind === "missing") {
            const recovered = await waitForRecoverableHealth(priorSessionForCheck, currentStepIndex);
            if (recovered === "stopped") {
              pendingResult = stopAfterInterruptedHealthWait(priorSessionForCheck, currentStepIndex);
              continue;
            }
            if (recovered === "unknown") {
              result = failAfterUnrecoveredServer(priorSessionForCheck, currentStepIndex);
              break;
            }
            ev = await evaluatePriorSession({
              client,
              repoDir,
              sessionID: priorSessionForCheck,
              messageID: lastPromptMessageID,
            });
          }
          const shouldReattach =
            ev.pending ||
            ev.classification.kind === "done" ||
            ev.classification.kind === "in-progress";
          if (shouldReattach) {
            if (!shouldEvaluatePriorSessionForReattach({ sessionID: priorSessionForCheck, messageID: lastPromptMessageID, reattachCount })) {
              const reason = ev.pending
                ? `reattach limit (${MAX_REATTACH_PER_STEP}) reached while session is still busy on opencode side`
                : ev.classification.kind === "in-progress"
                  ? `reattach limit (${MAX_REATTACH_PER_STEP}) reached while assistant message still in-progress`
                  : `reattach limit (${MAX_REATTACH_PER_STEP}) reached after assistant message completed server-side`;
              result = failAfterActivePriorSession(priorSessionForCheck, currentStepIndex, reason);
              break;
            }
            reattachCount += 1;
            const why = ev.pending
              ? "session still busy on opencode side"
              : ev.classification.kind === "done"
                ? "assistant message completed server-side despite client error"
                : "assistant message still in-progress";
            pushAgentLine(state, `[looper] ${step.name} reattaching (${reattachCount}/${MAX_REATTACH_PER_STEP}) to session ${priorSessionForCheck} — ${why}`);
            pushStepOutputLine(state, currentStepIndex, `[looper] ${step.name} reattaching (${reattachCount}/${MAX_REATTACH_PER_STEP}) to session ${priorSessionForCheck} — ${why}`);
            pendingResult = await reattachOpenCodeStep({
              state,
              stepIndex: currentStepIndex,
              client,
              repoDir,
              step,
              sessionID: priorSessionForCheck,
              outcomeMessageID: lastPromptMessageID,
              timeoutMsOverride: Math.max(0, budgetMs - (Date.now() - stepStartTime)),
              ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
              ...(questionPolicy !== undefined ? { questionPolicy } : {}),
              ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
            });
            continue;
          }
          if (ev.classification.kind === "failed" || ev.classification.kind === "empty") {
            lastErrorMessage = ev.classification.errorMessage;
          }
        }

        const priorSessionID = state.steps[currentStepIndex]?.sessionID;
        logRecoveryBoundary(currentStepIndex, "retry", priorSessionID, lastPromptMessageID);

        if (priorSessionID !== undefined) {
          let pending: SessionHealthState = await sessionPendingState(client, repoDir, priorSessionID);
          if (pending === "unknown") pending = await waitForRecoverableHealth(priorSessionID, currentStepIndex);
          if (pending === "stopped") {
            pendingResult = stopAfterInterruptedHealthWait(priorSessionID, currentStepIndex);
            continue;
          }
          if (pending === "unknown") {
            result = failAfterUnrecoveredServer(priorSessionID, currentStepIndex);
            break;
          }
          if (pending !== "idle") {
            const line = `[looper] ${step.name}: prior session ${priorSessionID} still ${pending}; aborting before retrying in a fresh session`;
            pushAgentLine(state, line);
            pushStepOutputLine(state, currentStepIndex, line);
            notify();
          }
          if (pending !== "idle" && !(await stopPriorSession(priorSessionID, currentStepIndex))) {
            result = failAfterUnconfirmedStop(priorSessionID, currentStepIndex, "retrying in a fresh session");
            break;
          }
        }

        failureRetryCount = failureDecision.attempt;
        const delayMs = failureDecision.delayMs;
        const delaySeconds = Math.round(delayMs / 1000);
        const attemptTag = `attempt ${failureRetryCount}/${MAX_FAILURE_RETRIES_PER_STEP}`;

        const targetSuffix = `will retry with a fresh session`;
        const failedStepIndex = currentStepIndex;
        currentStepIndex = insertFailureRetryAttempt(state, currentStepIndex);
        stepIndexForTitle = currentStepIndex;
        resumeSessionID = undefined;
        resumePrompt = failureRetryPrompt(promptText(step), priorSessionID);
        const waitingLine = `[looper] ${step.name} failed: ${errReason} \u2014 waiting ${delaySeconds}s before retry (${attemptTag}); ${targetSuffix}`;
        pushAgentLine(state, waitingLine);
        pushStepOutputLine(state, failedStepIndex, waitingLine);
        const activeStep = state.steps[currentStepIndex];
        resetStepRowToPending(state, currentStepIndex, { statusMessage: `retry in ${delaySeconds}s` });
        await sleepInterruptible(state, delayMs);
        if (!(state.quitting || stopFileExists() || state.skipRequested || state.restartRequested)) {
          stepStartTime = Date.now();
          const retryingLine = `[looper] ${step.name} retrying now (${attemptTag})`;
          pushAgentLine(state, retryingLine);
          pushStepOutputLine(state, currentStepIndex, retryingLine);
          if (activeStep) activeStep.statusMessage = undefined;
          notify();
        }
        continue;
      }

      break;
    }

    const prdAfter = snapshotPrd(adjudication, prdDir);
    if (adjudication !== undefined) {
      recordStepTransitions({
        adjudication,
        before: prdBefore,
        after: prdAfter,
        iteration,
        stepName: step.name,
        detect: !adjudicating,
      });
    }

    const routing = adjudicating ? { kind: "continue" as const } : decideRouting(adjudication);
    if (!adjudicating && routing.kind !== "continue" && result.status !== "done") {
      const terminalSessionID = state.steps[currentStepIndex]?.sessionID;
      if (!(await stopPriorSession(terminalSessionID, currentStepIndex)) && terminalSessionID !== undefined) {
        titleCoordinator?.cancel();
        cancelInheritedTitleTimer();
        throw new StepFailureError(
          `could not confirm session ${terminalSessionID} stopped; deferring adjudication to avoid overlapping opencode generations`,
          { stepName: step.name, sessionID: terminalSessionID },
        );
      }
    }
    if (routing.kind !== "continue") hooks?.onAdjudicationRoute?.({ iteration, totalSteps: steps.length });
    if (routing.kind === "stop") {
      markRemainingSkipped(state, currentStepIndex + 1);
      adjudication?.writeStop(routing.reason);
      adjudication?.store.clearMarker();
    } else if (routing.kind === "adjudicate") {
      markRemainingSkipped(state, currentStepIndex + 1);
      pendingAdjudicateStep = routing.step;
      insertAdjudicationRow(state, routing.step.name);
    }

    if (result.status === "failed" && routing.kind === "continue" && !adjudicating) {
      titleCoordinator?.cancel();
      cancelInheritedTitleTimer();
      const stopRequested = state.quitting || stopFileExists();
      // Terminal failure (retry exhausted / suppressed / stop requested): make
      // sure the step's session is actually stopped so it doesn't keep running
      // server-side after we surface the failure. Use a short budget when the
      // user is quitting so teardown stays responsive.
      const terminalSessionID = state.steps[currentStepIndex]?.sessionID;
      const terminalStopConfirmed = allowTerminalSessionToContinue
        ? false
        : await stopPriorSession(
            terminalSessionID,
            currentStepIndex,
            stopRequested ? STOP_SESSION_QUIT_TIMEOUT_MS : undefined,
          );
      if ((allowTerminalSessionToContinue || !terminalStopConfirmed) && terminalSessionID !== undefined) {
        logStepLine(currentStepIndex, `[looper] ${step.name}: session ${terminalSessionID} may still be running after terminal failure`);
      }
      if (stopRequested) {
        markRemainingSkipped(state, currentStepIndex);
        break;
      }
      const reason = lastErrorMessage ?? "unknown error (no message reported)";
      throw new StepFailureError(
        `${step.name} failed after ${failureRetryCount} retr${failureRetryCount === 1 ? "y" : "ies"}: ${reason}`,
        { stepName: step.name, ...(terminalSessionID !== undefined ? { sessionID: terminalSessionID } : {}) },
      );
    }

    if (result.status === "done" && result.sessionID !== undefined) {
      if (titleCoordinator !== undefined) {
        // applyTitle was called eagerly inside the coordinator the moment
        // generation succeeded (branch poll, delay timer, or in-step). resolve()
        // also covers the "no signal fired yet, snapshot at step end" fallback.
        await titleCoordinator.resolve(result.sessionID);
      } else if (usingInheritedTitle) {
        cancelInheritedTitleTimer();
        // A mid-step apply may have targeted an earlier session (before a
        // retry/timeout swapped it out). Drain it, then force one apply against
        // the FINAL session (no-op if that session was already titled).
        if (inheritedTitleInflight !== undefined) await inheritedTitleInflight;
        await startInheritedTitleApply();
      }
    } else {
      titleCoordinator?.cancel();
      cancelInheritedTitleTimer();
    }

    if (adjudicating) {
      pendingAdjudicateStep = undefined;
      if (result.status === "done") {
        // Only a completed adjudication resolves the conflict: advance the
        // history watermark so the resolved flips no longer count toward
        // detection, then drop the durable adjudication signals.
        adjudication?.store.markAdjudicated();
        adjudication?.store.clearMarker();
        adjudication?.store.clearSession();
        break;
      }
      // Fail closed: keep the marker so the next iteration / resume re-routes
      // to adjudication rather than treating a failed adjudicator as resolved.
      // Confirm its session is stopped first so a retry can't overlap it.
      titleCoordinator?.cancel();
      cancelInheritedTitleTimer();
      const adjSessionID = state.steps[currentStepIndex]?.sessionID;
      if (await stopPriorSession(adjSessionID, currentStepIndex)) adjudication?.store.clearSession();
      if (state.quitting || stopFileExists()) {
        markRemainingSkipped(state, currentStepIndex);
        break;
      }
      throw new StepFailureError(
        `adjudicate step failed: ${lastErrorMessage ?? "adjudicator did not complete"}`,
        { stepName: step.name, ...(adjSessionID !== undefined ? { sessionID: adjSessionID } : {}) },
      );
    }

    const routed = routing.kind !== "continue";
    hooks?.onStepFinish?.({ step, index, nextIndex: routed ? steps.length : index + 1, totalSteps: steps.length, iteration, status: result.status, ...(workDescription !== undefined ? { title: workDescription } : {}) });

    const finishedSessionID = state.steps[currentStepIndex]?.sessionID;
    completedLogicalSteps.push({
      stepIndex: index,
      name: step.name,
      status: result.status,
      ...(finishedSessionID !== undefined ? { sessionID: finishedSessionID } : {}),
    });

    completed.splice(0, completed.length, ...state.steps.slice(0, currentStepIndex + 1).map((step) => ({ ...step })));

    index = routed ? steps.length : index + 1;
  }

  return state.quitting || state.stopAfterIteration || stopFileExists() || stopAfterIterationFileExists()
    ? "stopped"
    : "complete";
}
