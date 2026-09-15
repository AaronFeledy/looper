import { readFileSync } from "node:fs";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { DEFAULT_STEP_TIMEOUT_MS, failureRetryJitterRatio, failureRetryMinRemainingMs, gateScriptTimeoutMs, inheritedRenameDelayMs, stopSessionConfirmTimeoutMs } from "../config/tunables.ts";
import { loadSteps, resolveContextPolicy, type ContextPolicy, type LoadedStep, type PermissionPolicy, type QuestionPolicy, type RecoverySnapshotsConfig, type TitleGenConfig } from "../lib/config.ts";
import { countPrd, derivePrdPaths, prdIndexPath, readPrdStories } from "../lib/prd.ts";
import { appendBlockedStepToProgress, appendGateSkipToProgress, resolveProgressFilePath } from "../lib/prd-progress.ts";
import { cleanRestartPrompt, failureRetryPrompt, recoveryNudgePrompt, backgroundContinuationPrompt, orphanedBackgroundNudgePrompt, textEndsWithNewline } from "../core/prompt-builders.ts";
import { decideResume, type ResumeWorkState } from "../core/resume-policy.ts";
import { applyFailureRetryJitter, MAX_REATTACH_PER_STEP, nextActionForBackgroundResume, nextActionForOrphanedBackgroundNudge } from "../core/retry-policy.ts";
import { createStepAttemptState, decideAfterFailurePolicy, decideAfterPriorEvaluation, decideAfterPriorHealth, type PriorHealthDecision } from "../core/step-attempt.ts";
import type { StoryStatePort, TitleService } from "./engine-ports.ts";
import { TitleCoordinator, titleModeFor } from "./title-coordinator.ts";
import { createStoryBranchMismatchMonitor, decideStoryBranchMismatch, storyBranchMismatchLogLine, storyBranchMismatchPrompt, type StoryBranchMismatch } from "./story-branch-nudge.ts";
import { readBranchFromHead, resolveGitHeadPath } from "../watchers/branch.ts";
import { fetchPromptVcsDelta } from "../watchers/branch-delta.ts";
export { FALLBACK_BASE_BRANCHES, MAINLINE_BRANCH_NAMES, isMainlineRef, commitsAheadOfRef, normalizeGitStatusCode, parseNumstatZ, parseNameStatusZ, branchDeltaChangedFiles, resolveBranchDelta, fetchBranchDelta, fetchPromptVcsDelta } from "../watchers/branch-delta.ts";
export type { BranchDelta, BranchDeltaChange } from "../watchers/branch-delta.ts";
import { buildLooperContext, withLooperContext, type ContextInput, type PriorStepInfo } from "../lib/prompt-context.ts";
import { latestUserMessageID } from "../opencode/assistant-classification.ts";
import { createRequestBrokerOwner } from "../opencode/request-broker-owner.ts";
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
import { currentGitBranch, DEFAULT_STORY_ID_PATTERN, storyIdFromBranch } from "../lib/story-id.ts";
import { comparePhase, type StoryPhase } from "../lib/story-state-files.ts";
import { readSignalsSince, type SignalLogRecord } from "../lib/signal-log.ts";
import { createStoryStateStore } from "../persistence/story-state-store.ts";
import { loopStateRunStepContext } from "../lib/loop-state-reporter.ts";
import {
  decideRouting,
  insertAdjudicationRow,
  recordStepTransitions,
  snapshotPhases,
  withAdjudicationReason,
  type AdjudicationRuntime,
} from "./adjudication-routing.ts";
import { evaluateGate, runGateScript } from "./step-gate.ts";
import { remainingStepBudgetMs, type RunControl, type RunControlView } from "./run-control.ts";
import { decideStepOutcome, lowerPhases, type OutcomeSignalKind } from "./step-outcome.ts";
import { createStoryPhaseResolver, selectNextStory, type StoryPhaseResolver } from "./story-phases.ts";

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

function currentGitHead(repoDir: string): string | undefined {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
    });
    if (result.exitCode !== 0) return undefined;
    const head = result.stdout.toString().trim();
    return head.length > 0 ? head : undefined;
  } catch {
    // no-excuse-ok: catch -- HEAD movement is a best-effort phase-reset signal
    return undefined;
  }
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

export type StepCompletionKind = "done" | "gate-skip" | "runtime-skip" | "blocked";

export type RunIterationHooks = {
  onStepBegin?: (info: { step: Step; index: number; totalSteps: number; iteration: number; title?: string }) => void;
  onStepFinish?: (info: { step: Step; index: number; nextIndex: number; totalSteps: number; iteration: number; status: StepResult; completionKind: StepCompletionKind; title?: string }) => void;
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
  control?: RunControl;
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
  unattended?: boolean;
  writeStop?: (reason: string) => void;
  useSessionIdle?: boolean;
  prdDir?: string;
  storyIdPattern?: string;
  storyState?: StoryStatePort;
  storyResolver?: StoryPhaseResolver;
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

async function waitWhilePaused(control: RunControlView): Promise<void> {
  while (control.paused && !control.quitting && !stopFileExists()) {
    await Bun.sleep(100);
  }
}

/**
 * Shorter confirm-stop budget used when the loop is quitting / a stop file is
 * present, so Ctrl-C does not feel hung waiting for opencode to confirm an
 * abort before we tear down.
 */
const STOP_SESSION_QUIT_TIMEOUT_MS = 1_500;
async function sleepInterruptible(control: RunControlView, totalMs: number): Promise<void> {
  const step = 100;
  let remaining = totalMs;
  while (remaining > 0) {
    if (control.quitting || stopFileExists() || control.skipRequested || control.restartRequested) return;
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
    unattended = false,
    writeStop,
    useSessionIdle,
    prdDir,
    storyIdPattern,
    storyState: providedStoryState,
    storyResolver,
    adjudication,
    maxIterations,
    contextPolicy: globalContextPolicy,
    resumedStepSessions,
  } = options;
  const control = options.control ?? state.control;
  const prdPaths = prdDir === undefined ? undefined : derivePrdPaths(prdDir, repoDir);
  const completed: LoopStep[] = [];
  // Logical-step ledger for the `<looper-context>` prior-steps section, keyed
  // by `stepIndex` (config position; immune to duplicate step names) rather
  // than row position in `state.steps` or dedupe-by-name like `completed`
  // above (which is left untouched and keeps driving existing UI rendering).
  // Exactly one entry is pushed per logical step, only once its retry/restart
  // loop has fully resolved, so a step's own attempts never show up here as a
  // distinct prior step.
  const completedLogicalSteps: { stepIndex: number; name: string; status: string; sessionID?: string }[] = [];
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
  const storyState = providedStoryState ?? createStoryStateStore({ configDir });

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
  const phaseResolver = storyResolver ?? (prdDir === undefined
    ? undefined
    : createStoryPhaseResolver({
        repoDir,
        prdIndex: prdIndexPath(prdDir),
        storyState,
        ...(storyIdPattern !== undefined ? { storyIdPattern } : {}),
      }));

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
        if (initialRouting.kind === "stop") {
          adjudication?.writeStop(initialRouting.reason);
          adjudication?.store.clearMarker();
          break;
        }
        hooks?.onAdjudicationRoute?.({ iteration, totalSteps: steps.length });
        pendingAdjudicateStep = initialRouting.step;
        insertAdjudicationRow(state, initialRouting.step.name);
      }
    }

    const adjudicating = pendingAdjudicateStep !== undefined;
    if (!adjudicating && index >= steps.length) break;

    const recoveryRowIndex = state.steps.length - (steps.length - index);
    const preserveRecoveryRow = !adjudicating
      && recoveryNudgePending
      && pendingResume?.sessionID !== undefined
      && state.steps[recoveryRowIndex]?.name === steps[index]?.name;
    if (!adjudicating && !preserveRecoveryRow) syncStepsUiState(state, steps, index, completed, resumedPriorSteps ? "done" : "skipped");
    let currentStepIndex = adjudicating ? state.steps.length - 1 : state.steps.length - (steps.length - index);

    if (stopFileExists() || control.quitting) {
      markRemainingSkipped(state, currentStepIndex);
      break;
    }

    await waitWhilePaused(control);

    if (stopFileExists() || control.quitting) {
      markRemainingSkipped(state, currentStepIndex);
      break;
    }

    const configuredStep = steps[index];
    if (pendingAdjudicateStep === undefined && configuredStep === undefined) break;
    const step = pendingAdjudicateStep ?? configuredStep;
    if (step === undefined) break;
    const executionIndex = adjudicating ? steps.length : index;
    const executionTotalSteps = adjudicating ? steps.length + 1 : steps.length;
    const ctx = loopStateRunStepContext(state, control);
    const stepContextPolicy = resolveContextPolicy(step, { contextPolicy: globalContextPolicy });
    const needsStoryFacts = !adjudicating && (
      step.gate !== undefined ||
      stepContextPolicy.story ||
      step.setsPhase !== undefined ||
      step.expects !== undefined ||
      (adjudication !== undefined && prdDir !== undefined)
    );
    const branch = needsStoryFacts ? await currentGitBranch(repoDir) : undefined;
    const storySnapshot = !adjudicating && needsStoryFacts ? phaseResolver?.snapshot() : undefined;
    const prdStories = storySnapshot?.stories ?? (!adjudicating && prdDir !== undefined && needsStoryFacts
      ? readPrdStories(prdIndexPath(prdDir))
      : undefined);
    const storyIds = prdStories?.map((story) => story.id);
    const branchStoryId = branch === undefined ? undefined : storyIdFromBranch(branch, storyIdPattern, storyIds);
    const selectedNext = storySnapshot === undefined ? undefined : selectNextStory(storySnapshot, branchStoryId);
    if (selectedNext?.reason !== undefined) logStepLine(currentStepIndex, `[looper] ${selectedNext.reason}`);
    const configuredBranchStoryId = branchStoryId !== undefined && prdStories?.some(({ id }) => id === branchStoryId)
      ? branchStoryId
      : undefined;
    const storyId = prdDir === undefined
      ? branchStoryId
      : configuredBranchStoryId ?? selectedNext?.story.id;
    const phase = storyId === undefined || (!stepContextPolicy.story && step.gate === undefined && step.setsPhase === undefined && step.expects === undefined)
      ? undefined
      : storySnapshot?.phases[storyId] ?? storyState.readPhase(storyId);
    const finalizeLogicalStep = (input: {
      readonly status: StepResult;
      readonly completionKind: StepCompletionKind;
      readonly nextIndex: number;
      readonly rowIndex: number;
      readonly recordPriorStep: boolean;
      readonly priorStatus?: string;
    }): void => {
      hooks?.onStepFinish?.({
        step,
        index,
        nextIndex: input.nextIndex,
        totalSteps: steps.length,
        iteration,
        status: input.status,
        completionKind: input.completionKind,
        ...(workDescription !== undefined ? { title: workDescription } : {}),
      });

      if (input.recordPriorStep) {
        const finishedSessionID = state.steps[input.rowIndex]?.sessionID;
        completedLogicalSteps.push({
          stepIndex: index,
          name: step.name,
          status: input.priorStatus ?? input.status,
          ...(finishedSessionID !== undefined ? { sessionID: finishedSessionID } : {}),
        });
      }

      completed.splice(0, completed.length, ...state.steps.slice(0, input.rowIndex + 1).map((row) => ({ ...row })));
      index = input.nextIndex;
    };

    const applyRouting = (routing: ReturnType<typeof decideRouting>, remainingFromIndex: number): void => {
      if (routing.kind === "continue") return;
      markRemainingSkipped(state, remainingFromIndex);
      if (routing.kind === "stop") {
        adjudication?.writeStop(routing.reason);
        adjudication?.store.clearMarker();
        return;
      }
      hooks?.onAdjudicationRoute?.({ iteration, totalSteps: steps.length });
      pendingAdjudicateStep = routing.step;
      insertAdjudicationRow(state, routing.step.name);
    };

    if (!adjudicating && step.gate !== undefined) {
      const declarativeGate = {
        ...(step.gate.branch !== undefined ? { branch: step.gate.branch } : {}),
        ...(step.gate.phase !== undefined ? { phase: step.gate.phase } : {}),
        ...(step.gate.phaseBelow !== undefined ? { phaseBelow: step.gate.phaseBelow } : {}),
      };
      let gateDecision = evaluateGate({ gate: declarativeGate, branch, branchStoryId: branchStoryId ?? null, storyId, phase, storyIdPattern: storyIdPattern ?? DEFAULT_STORY_ID_PATTERN });
      if (gateDecision.pass && step.gate.script !== undefined) {
        const adjudicationCompletions = adjudication?.store.readCompletions() ?? [];
        const lastAdjudication = adjudicationCompletions[adjudicationCompletions.length - 1];
        const scriptResult = await runGateScript(step.gate.script, {
            repoDir,
            adjudicationCount: adjudicationCompletions.length,
            ...(lastAdjudication !== undefined ? { lastAdjudicatedAt: lastAdjudication.at } : {}),
            ...(branch !== undefined ? { branch } : {}),
            ...(storyId !== undefined ? { storyId } : {}),
            ...(prdPaths !== undefined ? {
              prdDir: prdPaths.dir,
              prdIndex: prdPaths.index,
              prdProgress: prdPaths.progress,
            } : {}),
            timeoutMs: gateScriptTimeoutMs(),
          });
        gateDecision = evaluateGate({ gate: step.gate, branch, branchStoryId: branchStoryId ?? null, storyId, phase, storyIdPattern: storyIdPattern ?? DEFAULT_STORY_ID_PATTERN, scriptResult });
      }
      if (!gateDecision.pass) {
        const resumedSessionID = pendingResume?.sessionID;
        if (resumedSessionID !== undefined && !(await stopPriorSession(resumedSessionID, currentStepIndex))) {
          throw new StepFailureError(
            `could not confirm session ${resumedSessionID} stopped; not gate-skipping ${step.name} to avoid overlapping opencode generations`,
            { stepName: step.name, sessionID: resumedSessionID },
          );
        }
        pendingResume = undefined;
        recoveryNudgePending = false;
        failStepRow(state, currentStepIndex, "skipped");
        logStepLine(currentStepIndex, `[looper] gate skipped ${step.name}: ${gateDecision.reason}`);
        if (prdPaths !== undefined) {
          const appended = appendGateSkipToProgress({
            progressPath: resolveProgressFilePath(prdPaths.progress, repoDir),
            stepName: step.name,
            reason: gateDecision.reason,
          });
          if (!appended.appended) logStepLine(currentStepIndex, `[looper] failed to append gate skip to progress: ${appended.error}`);
        }
        const routing = decideRouting(adjudication);
        // Match post-step routing: when we divert to stop/adjudicate, park the
        // resume pointer at the end of the configured steps (adjudicate is not a
        // resumable position; the marker is the durable signal).
        finalizeLogicalStep({
          status: "skipped",
          completionKind: "gate-skip",
          nextIndex: routing.kind === "continue" ? index + 1 : steps.length,
          rowIndex: currentStepIndex,
          recordPriorStep: false,
        });
        applyRouting(routing, currentStepIndex + 1);
        continue;
      }
    }

    if (!adjudicating) hooks?.onStepBegin?.({ step, index, totalSteps: steps.length, iteration, ...(workDescription !== undefined ? { title: workDescription } : {}) });
    // Phase history still diffs around the adjudicate step (detect is off;
    // recording is not). Resolve PRD story ids even while adjudicating so a
    // mid-step phase write is still appended, preserving always-on history.
    const phaseStoryIds: string[] = (() => {
      if (adjudication === undefined) return [];
      if (prdDir !== undefined) {
        const fromPrd = readPrdStories(prdIndexPath(prdDir))?.map((story) => story.id);
        if (fromPrd !== undefined) return fromPrd;
      }
      return storyIds !== undefined ? [...storyIds] : storyId !== undefined ? [storyId] : [];
    })();
    const phasesBefore =
      adjudication !== undefined ? snapshotPhases(storyState.readPhase, phaseStoryIds) : undefined;
    let signalPhasesBefore = phasesBefore;
    const stepWindowStartedAt = Date.now();
    const headAtStepStart = step.expects === undefined ? undefined : currentGitHead(repoDir);
    const phasesAtStepStart = storySnapshot?.phases;
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
    const attempt = createStepAttemptState();
    let outcomeReminderSent = false;
    let outcomeReminderPending = false;
    let blockedReason: string | undefined;
    let completedStoryId = storyId;
    let completedStorySnapshot = storySnapshot;
    let expectsPhaseSatisfied = step.expects === undefined;
    let phaseResetApplied = false;
    // A step that expects phase P and lands new commits makes any STORED phase
    // at or above P stale: the story was re-worked, so it drops to the phase just
    // below P and this step must re-prove P with a signal. Runs BEFORE the
    // outcome decision so a stale phase can never satisfy `expects`.
    // An explicit `story-phase` signal for the story during this step is the
    // agent's own re-proof and is never overridden by the reset.
    const applyCommitPhaseReset = (storyId: string | undefined, signals: readonly SignalLogRecord[]): void => {
      if (step.expects === undefined || storyId === undefined || headAtStepStart === undefined || phaseResetApplied) return;
      if (signals.some((record) => record.kind === "story-phase" && (record.storyId === undefined || record.storyId === storyId))) return;
      const headAtStepEnd = currentGitHead(repoDir);
      if (headAtStepEnd === undefined || headAtStepEnd === headAtStepStart) return;
      const storedBeforeReset = storyState.readPhase(storyId);
      if (storedBeforeReset === undefined || comparePhase(storedBeforeReset, step.expects) < 0) return;
      const resetTo = lowerPhases(step.expects).at(-1);
      if (resetTo === undefined) return;
      storyState.writePhase(storyId, resetTo);
      phaseResetApplied = true;
      if (signalPhasesBefore !== undefined) signalPhasesBefore = { ...signalPhasesBefore, [storyId]: resetTo };
      logStepLine(currentStepIndex, `[looper] story ${storyId}: phase reset to ${resetTo} (new commits during ${step.name})`);
      if (adjudication !== undefined) {
        recordStepTransitions({
          adjudication,
          before: { [storyId]: storedBeforeReset },
          after: { [storyId]: resetTo },
          iteration,
          stepName: step.name,
          detect: false,
          source: "engine",
        });
      }
    };
    const onGateTimeout = (info: { readonly permission?: string; readonly kind: "permission" | "question" }): void => {
      attempt.engineBlockReason = `permission gate timed out: ${info.permission ?? info.kind}`;
    };
    if (recoveryNudgePending) {
      recoveryNudgePending = false;
      attempt.recoveryNudgeActive = true;
    }
    const budgetMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    let stepStartTime = Date.now();
    control.clearTimeoutBonus();
    const remainingBudget = () => remainingStepBudgetMs(budgetMs, stepStartTime, control.timeoutBonusMs);
    let gatePausedAt: number | undefined;
    const requestBrokerOwner = createRequestBrokerOwner({
      requests: ctx.reporter.requests,
      client,
      repoDir,
      configDir,
      stepIndex: index,
      step,
      pushLine: (line) => logStepLine(currentStepIndex, line),
      unattended,
      friction: { counts: attempt.permissionFrictionCounts, requestIDs: attempt.permissionFrictionRequestIDs },
      ...(writeStop !== undefined ? { writeStop } : {}),
      ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
      ...(questionPolicy !== undefined ? { questionPolicy } : {}),
      onHumanGateChange: (open) => {
        if (open && gatePausedAt === undefined) gatePausedAt = Date.now();
        if (!open && gatePausedAt !== undefined) {
          stepStartTime += Date.now() - gatePausedAt;
          gatePausedAt = undefined;
        }
      },
      onGateTimeout,
    });
    const stopStepSession = async (sessionID: string | undefined, stepIdx: number, timeoutMs?: number): Promise<boolean> => {
      if (sessionID === undefined) return true;
      if (!requestBrokerOwner.owns(sessionID)) return await stopPriorSession(sessionID, stepIdx, timeoutMs);
      const teardown = await requestBrokerOwner.teardown(sessionID, timeoutMs ?? stopSessionConfirmTimeoutMs());
      if (teardown.safeToProceed) return true;
      logStepLine(stepIdx, `[looper] ${teardown.reason}`);
      return false;
    };
    const failAfterUnconfirmedStop = (sessionID: string, stepIdx: number, action: string): StepRunResult => {
      const reason = `could not confirm session ${sessionID} stopped; not ${action} to avoid overlapping opencode generations`;
      attempt.suppressFailureRetry = true;
      attempt.suppressReason = reason;
      attempt.lastErrorMessage = reason;
      logStepLine(stepIdx, `[looper] ${reason}`);
      failStepRow(state, stepIdx, "failed");
      return { status: "failed", sessionID, errorMessage: reason };
    };
    const failAfterUnrecoveredServer = (sessionID: string, stepIdx: number): StepRunResult => {
      const reason = `server did not recover while checking session ${sessionID}; leaving the session alone so it can complete in the background`;
      attempt.suppressFailureRetry = true;
      attempt.suppressReason = reason;
      attempt.allowTerminalSessionToContinue = true;
      attempt.lastErrorMessage = reason;
      logStepLine(stepIdx, `[looper] ${reason}`);
      failStepRow(state, stepIdx, "failed");
      return { status: "failed", sessionID, errorMessage: reason };
    };
    const failAfterActivePriorSession = (sessionID: string, stepIdx: number, reason: string): StepRunResult => {
      attempt.suppressFailureRetry = true;
      attempt.suppressReason = reason;
      attempt.allowTerminalSessionToContinue = true;
      attempt.lastErrorMessage = reason;
      logStepLine(stepIdx, `[looper] ${reason}; leaving session ${sessionID} alone so it can complete`);
      failStepRow(state, stepIdx, "failed");
      return { status: "failed", sessionID, errorMessage: reason };
    };
    const stopAfterInterruptedHealthWait = (sessionID: string, stepIdx: number): StepRunResult => {
      if (control.restartRequested) {
        const reason = control.restartReason ?? "manual";
        logStepLine(stepIdx, `[looper] server health check stopped by ${reason} restart request for session ${sessionID}`);
        return { status: "restart", sessionID, restartReason: reason };
      }
      if (control.quitting || stopFileExists()) {
        const reason = `stop requested while checking session ${sessionID}`;
        attempt.lastErrorMessage = reason;
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
        shouldStop: () => control.quitting || stopFileExists() || control.skipRequested || control.restartRequested,
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
            recoveryNudgeActive: attempt.recoveryNudgeActive,
          });
          if (resumeDecision.kind === "reattach" && resumeInfo.messageID !== undefined) {
            logStepLine(currentStepIndex, `[looper] resuming ${step.name}: session ${resumeSession} still active; reattaching`);
            attempt.lastPromptMessageID = resumeInfo.messageID;
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
              ctx,
              stepIndex: currentStepIndex,
              client,
              repoDir,
              step,
              sessionID: resumeSession,
              outcomeMessageID: resumeInfo.messageID,
              ...(resumeInfo.promptText !== undefined ? { promptText: resumeInfo.promptText } : {}),
              ...(resumeInfo.looperMessageIDs !== undefined ? { looperMessageIDs: resumeInfo.looperMessageIDs } : {}),
              timeoutMsOverride: remainingBudget(),
              ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
              ...(questionPolicy !== undefined ? { questionPolicy } : {}),
              ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
              requestBrokerOwner,
            });
          } else if (resumeDecision.kind === "nudge-existing") {
            logStepLine(currentStepIndex, `[looper] resuming ${step.name}: prior session ${resumeSession} is idle; nudging the existing session`);
            attempt.resumeSessionID = resumeSession;
            attempt.resumePrompt = recoveryNudgePrompt();
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
              if (!(await stopStepSession(resumeSession, currentStepIndex))) {
                pendingResult = failAfterUnconfirmedStop(resumeSession, currentStepIndex, "restarting after resume");
              }
            }
          }
        }
      }
    }
    if (
      attempt.recoveryNudgeActive
      && attempt.resumeSessionID === undefined
      && attempt.resumePrompt === undefined
      && pendingResult === undefined
    ) {
      attempt.resumePrompt = cleanRestartPrompt(promptText(step), "manual");
    }

    const resolvedStoryIdPattern = storyIdPattern ?? DEFAULT_STORY_ID_PATTERN;
    const stepHeadPath = await resolveGitHeadPath(repoDir);
    const readStepBranch = (): string | undefined => {
      if (stepHeadPath !== null) {
        const fromHead = readBranchFromHead(stepHeadPath);
        if (fromHead !== null) return fromHead;
      }
      return undefined;
    };
    const readStoryIds = (): string[] | undefined => {
      if (prdDir === undefined) return undefined;
      const stories = readPrdStories(prdIndexPath(prdDir));
      return stories === undefined ? undefined : stories.map((story) => story.id);
    };
    const initialStepBranch = await currentGitBranch(repoDir);
    // A resumed failed repair must still be checked even though the branch
    // switch happened before this process/iteration invocation.
    const initialBranchForRepair = resume?.sessionID !== undefined && index === startStepIndex ? undefined : initialStepBranch;
    let branchRepair: StoryBranchMismatch | undefined;
    const mismatchMonitor = createStoryBranchMismatchMonitor({
      initialBranch: initialBranchForRepair,
      getStoryIds: readStoryIds,
      getBranch: readStepBranch,
      pattern: resolvedStoryIdPattern,
      onMismatch: (mismatch) => logStepLine(currentStepIndex, storyBranchMismatchLogLine(mismatch)),
    });

    try {
    while (true) {
      if (pendingResult !== undefined) {
        result = pendingResult;
        pendingResult = undefined;
      } else {
        const stepBasePrompt = adjudicating
          ? withAdjudicationReason(promptText(step), adjudication?.store.readMarker() ?? null)
          : promptText(step);
        let prompt = attempt.resumePrompt ?? stepBasePrompt;
        // Context is for new sessions only. Follow-up turns on an existing
        // session (recovery nudge, background continuation, orphaned-background
        // nudge) already have the original prompt in history.
        if (attempt.resumeSessionID === undefined) {
          const promptNeedsStoryFacts = !adjudicating && (stepContextPolicy.story || stepContextPolicy.prd);
          const promptBranch = promptNeedsStoryFacts ? await currentGitBranch(repoDir) : undefined;
          const promptSnapshot = promptNeedsStoryFacts ? phaseResolver?.snapshot() : undefined;
          const promptStories = promptSnapshot?.stories ?? (promptNeedsStoryFacts && prdDir !== undefined ? readPrdStories(prdIndexPath(prdDir)) : undefined);
          const promptStoryIds = promptStories?.map((story) => story.id);
          const promptBranchStoryId = promptBranch === undefined ? undefined : storyIdFromBranch(promptBranch, storyIdPattern, promptStoryIds);
          const promptNext = promptSnapshot === undefined ? undefined : selectNextStory(promptSnapshot, promptBranchStoryId);
          const promptPhase = promptBranchStoryId === undefined ? undefined : promptSnapshot?.phases[promptBranchStoryId] ?? storyState.readPhase(promptBranchStoryId);
          const freshStoryFacts: ContextInput["story"] = !stepContextPolicy.story
            ? undefined
            : {
                ...(promptBranch !== undefined ? { branch: promptBranch } : {}),
                branchRule: `${prdDir === undefined ? "" : "Exact PRD story ID followed by '-' and a description; otherwise "}pattern ${resolvedStoryIdPattern}, capture group 1 = story ID. Preserve the full story ID when creating or renaming branches.`,
                ...(promptBranchStoryId !== undefined ? { storyId: promptBranchStoryId } : {}),
                ...(promptPhase !== undefined ? { phase: promptPhase } : {}),
                ...(promptNext !== undefined
                  ? { next: { id: promptNext.story.id, ...(promptNext.story.title !== undefined ? { title: promptNext.story.title } : {}) } }
                  : {}),
                ...(step.expects !== undefined ? { expects: step.expects } : {}),
              };
          const priorSteps: PriorStepInfo[] = completedLogicalSteps.map((entry) => ({
            name: entry.name,
            status: entry.status,
            ...(entry.sessionID !== undefined ? { sessionID: entry.sessionID } : {}),
          }));
          const vcs = stepContextPolicy.vcsDelta
            ? await fetchPromptVcsDelta(client, repoDir, state.branch || undefined, (line) => logStepLine(currentStepIndex, line))
            : undefined;
          const prdCounts = stepContextPolicy.prd && promptSnapshot !== undefined ? countPrd(promptSnapshot) : undefined;
          const prd = prdCounts === undefined || promptSnapshot === undefined
            ? undefined
            : {
                ...prdCounts,
                terminal: promptSnapshot.terminal,
                phases: promptSnapshot.stories.flatMap((story) => {
                  const storyPhase = promptSnapshot.phases[story.id] ?? "building";
                  return comparePhase(storyPhase, promptSnapshot.terminal) < 0 ? [{ id: story.id, phase: storyPhase }] : [];
                }),
              };
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
            ...(prdPaths !== undefined ? { prdPaths } : {}),
            ...(vcs !== undefined ? { vcs } : {}),
            ...(freshStoryFacts !== undefined ? { story: freshStoryFacts } : {}),
          };
          prompt = withLooperContext(buildLooperContext(stepContextPolicy, contextInput), prompt);
        }
        result = await runOpenCodeStep({
          ctx,
          stepIndex: currentStepIndex,
          prompt,
          client,
          repoDir,
          step,
          sessionID: attempt.resumeSessionID,
          timeoutMsOverride: remainingBudget(),
          ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
          ...(questionPolicy !== undefined ? { questionPolicy } : {}),
          ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
          ...(stepSessionMetadata !== undefined ? { sessionMetadata: stepSessionMetadata } : {}),
          requestBrokerOwner,
          onGateTimeout,
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
      attempt.resumePrompt = undefined;
      const requestedRestartReason = control.restartReason;
      control.clearStepRequests();
      notify();

      if (result.messageID !== undefined) attempt.lastPromptMessageID = result.messageID;
      if (result.status === "failed" && result.errorMessage) {
        attempt.lastErrorMessage = result.errorMessage;
      }

      if (result.status === "waiting" && result.sessionID !== undefined) {
        const waitSessionID = result.sessionID;
        attempt.backgroundResumeCount += 1;
        const backgroundResumeDecision = nextActionForBackgroundResume(attempt.backgroundResumeCount);
        if (backgroundResumeDecision.kind === "fail") {
          result = { status: "failed" };
          attempt.suppressFailureRetry = true;
          attempt.suppressReason = `${backgroundResumeDecision.reason} for session ${waitSessionID}`;
          attempt.lastErrorMessage = attempt.lastErrorMessage ?? attempt.suppressReason;
          const line = `[looper] background task resume limit exceeded for session ${waitSessionID}`;
          pushAgentLine(state, line);
          pushStepOutputLine(state, currentStepIndex, line);
          failStepRow(state, currentStepIndex, "failed");
          break;
        }

        const remainingMs = remainingBudget();
        const waitResult = await waitForLoopContinuationIdle({ ctx, client, stepIndex: currentStepIndex, repoDir, sessionID: waitSessionID, timeoutMs: remainingMs });
        if (waitResult === "idle" && !control.quitting && !stopFileExists()) {
          attempt.resumeSessionID = waitSessionID;
          attempt.resumePrompt = backgroundContinuationPrompt();
          pushAgentLine(state, `[looper] background tasks idle; resuming session ${attempt.resumeSessionID}`);
          pushStepOutputLine(state, currentStepIndex, `[looper] background tasks idle; resuming session ${attempt.resumeSessionID}`);
          notify();
          continue;
        }

        if (waitResult === "resumed" && !control.quitting && !stopFileExists()) {
          // Track the continuation hook's own user message so the resumed
          // turn's outcome decides the step result; classifying against
          // attempt.lastPromptMessageID would grade the already-completed prior turn.
          const resumedMessageID = (await latestUserMessageID(client, repoDir, waitSessionID)) ?? attempt.lastPromptMessageID;
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
              ctx,
              stepIndex: currentStepIndex,
              client,
              repoDir,
              step,
              sessionID: waitSessionID,
              outcomeMessageID: resumedMessageID,
              timeoutMsOverride: remainingBudget(),
              ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
              ...(questionPolicy !== undefined ? { questionPolicy } : {}),
              ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
              requestBrokerOwner,
            });
            continue;
          }
        }

        if (waitResult === "orphaned" && !control.quitting && !stopFileExists()) {
          attempt.orphanNudgeCount += 1;
          const orphanNudgeDecision = nextActionForOrphanedBackgroundNudge(attempt.orphanNudgeCount);
          if (orphanNudgeDecision.kind === "fail") {
            result = { status: "failed" };
            attempt.suppressFailureRetry = true;
            attempt.suppressReason = `${orphanNudgeDecision.reason} for session ${waitSessionID}`;
            attempt.lastErrorMessage = attempt.lastErrorMessage ?? attempt.suppressReason;
            const line = `[looper] background marker still orphaned after nudge; failing closed for session ${waitSessionID}`;
            pushAgentLine(state, line);
            pushStepOutputLine(state, currentStepIndex, line);
            failStepRow(state, currentStepIndex, "failed");
            break;
          }
          attempt.resumeSessionID = waitSessionID;
          attempt.resumePrompt = orphanedBackgroundNudgePrompt();
          pushAgentLine(state, `[looper] background marker orphaned; nudging session ${attempt.resumeSessionID} to verify and finish`);
          pushStepOutputLine(state, currentStepIndex, `[looper] background marker orphaned; nudging session ${attempt.resumeSessionID} to verify and finish`);
          notify();
          continue;
        }

        if (waitResult === "restart") {
          const reason: StepRestartReason = control.restartReason ?? "manual";
          const previousStepIndex = currentStepIndex;
          if (!(await stopStepSession(waitSessionID, previousStepIndex))) {
            result = failAfterUnconfirmedStop(waitSessionID, previousStepIndex, "starting a restart session");
            break;
          }
          currentStepIndex = insertRestartAttempt(state, currentStepIndex, reason);
          stepIndexForTitle = currentStepIndex;
          stepStartTime = Date.now();
          attempt.resumeSessionID = undefined;
          attempt.resumePrompt = cleanRestartPrompt(promptText(step), reason);
          pushAgentLine(state, `[looper] restart requested during background wait for session ${waitSessionID}`);
          pushStepOutputLine(state, previousStepIndex, `[looper] restart requested during background wait for session ${waitSessionID}`);
          control.setRestartRequested(false);
          control.setRestartReason(undefined);
          resetStepRowToPending(state, currentStepIndex);
          continue;
        }

        if (waitResult === "timeout" && branchRepair !== undefined) {
          result = { status: "failed", sessionID: waitSessionID, errorMessage: "branch repair exhausted the remaining step time budget waiting for background work" };
          attempt.lastErrorMessage = result.errorMessage;
          failStepRow(state, currentStepIndex, "failed");
          break;
        }
        if (waitResult === "timeout") {
          const previousStepIndex = currentStepIndex;
          if (!(await stopStepSession(waitSessionID, previousStepIndex))) {
            result = failAfterUnconfirmedStop(waitSessionID, previousStepIndex, "starting a timeout restart session");
            break;
          }
          currentStepIndex = insertRestartAttempt(state, currentStepIndex, "timeout");
          stepIndexForTitle = currentStepIndex;
          stepStartTime = Date.now();
          attempt.resumeSessionID = undefined;
          attempt.resumePrompt = cleanRestartPrompt(promptText(step), "timeout");
          pushAgentLine(state, `[looper] timeout restarting ${step.name} after background wait for session ${waitSessionID}`);
          pushStepOutputLine(state, previousStepIndex, `[looper] timeout restarting ${step.name} after background wait for session ${waitSessionID}`);
          resetStepRowToPending(state, currentStepIndex);
          continue;
        }

        const skipLike = waitResult === "stopped" || waitResult === "skipped";
        result = { status: skipLike ? "skipped" : "failed" };
        if (!skipLike) {
          attempt.suppressFailureRetry = true;
          attempt.suppressReason = `background task wait ended with ${waitResult} for session ${waitSessionID}`;
          attempt.lastErrorMessage = attempt.lastErrorMessage ?? attempt.suppressReason;
        }
        failStepRow(state, currentStepIndex, result.status === "skipped" ? "skipped" : "failed");
        pushAgentLine(state, `[looper] background task wait ended with ${waitResult} for session ${waitSessionID}`);
        pushStepOutputLine(state, currentStepIndex, `[looper] background task wait ended with ${waitResult} for session ${waitSessionID}`);
        notify();
      }

      if (branchRepair !== undefined && result.status === "restart" && result.restartReason === "timeout") {
        result = { ...result, status: "failed", errorMessage: "branch repair exhausted the remaining step time budget" };
        failStepRow(state, currentStepIndex, "failed");
      }
      if (outcomeReminderPending && result.status === "failed") {
        outcomeReminderPending = false;
        attempt.suppressFailureRetry = true;
        attempt.suppressReason = "outcome reminder failed";
        attempt.lastErrorMessage = result.errorMessage ?? "outcome reminder failed";
      }
      if (result.status === "restart" && !control.quitting && !stopFileExists()) {
        const reason = result.restartReason ?? requestedRestartReason ?? "manual";
        const priorSessionID = result.sessionID ?? state.steps[currentStepIndex]?.sessionID;
        logRecoveryBoundary(currentStepIndex, "restart", priorSessionID, attempt.lastPromptMessageID);
        // Confirm the prior session is actually aborted before creating the
        // fresh restart session, so the old run can't keep generating in
        // parallel with the new one.
        if (!(await stopStepSession(priorSessionID, currentStepIndex)) && priorSessionID !== undefined) {
          result = failAfterUnconfirmedStop(priorSessionID, currentStepIndex, "starting a restart session");
          break;
        }
        currentStepIndex = insertRestartAttempt(state, currentStepIndex, reason);
        stepIndexForTitle = currentStepIndex;
        stepStartTime = Date.now();
        control.clearTimeoutBonus();
        attempt.resumeSessionID = undefined;
        attempt.resumePrompt = cleanRestartPrompt(promptText(step), reason);
        continue;
      }

      if (!adjudicating && result.status === "done" && !control.quitting && !stopFileExists()) {
        const currentBranch = await currentGitBranch(repoDir);
        const postStepSnapshot = phaseResolver?.snapshot();
        const storyIds = postStepSnapshot?.stories.map(({ id }) => id) ?? readStoryIds();
        const postBranchStoryId = currentBranch === undefined ? undefined : storyIdFromBranch(currentBranch, resolvedStoryIdPattern, storyIds);
        const configuredPostBranchStoryId = postBranchStoryId !== undefined && postStepSnapshot?.stories.some(({ id }) => id === postBranchStoryId)
          ? postBranchStoryId
          : undefined;
        completedStorySnapshot = postStepSnapshot ?? completedStorySnapshot;
        completedStoryId = configuredPostBranchStoryId ?? selectedNext?.story.id ?? completedStoryId;
        if (branchRepair !== undefined) {
          // A regex-only id that is not in the PRD is not a repair: outcome/setsPhase
          // would otherwise evaluate against selectedNext (a different story).
          const repairedStoryId = postStepSnapshot !== undefined ? configuredPostBranchStoryId : postBranchStoryId;
          if (repairedStoryId === undefined || (branchRepair.expectedStoryId !== undefined && repairedStoryId !== branchRepair.expectedStoryId)) {
            const message = `branch repair unresolved: current branch '${currentBranch ?? "unknown"}' must resolve to ${branchRepair.expectedStoryId ?? "a configured PRD story ID"}; ${step.name} cannot advance`;
            result = { ...result, status: "failed", errorMessage: message };
            attempt.lastErrorMessage = message;
            failStepRow(state, currentStepIndex, "failed");
            logStepLine(currentStepIndex, `[looper] ${message}`);
            break;
          }
          logStepLine(currentStepIndex, `[looper] branch repair verified: '${currentBranch}' resolves to ${repairedStoryId}`);
        } else {
          const mismatch = decideStoryBranchMismatch({ initialBranch: initialBranchForRepair, currentBranch, pattern: resolvedStoryIdPattern, storyIds });
          if (mismatch !== undefined && result.sessionID !== undefined) {
            branchRepair = mismatch;
            logStepLine(currentStepIndex, storyBranchMismatchLogLine(mismatch));
            attempt.resumeSessionID = result.sessionID;
            attempt.resumePrompt = storyBranchMismatchPrompt(mismatch);
            continue;
          }
        }
      }
      if (!adjudicating && result.status === "done" && step.expects !== undefined) {
        outcomeReminderPending = false;
        const signals = readSignalsSince(configDir, stepWindowStartedAt).filter(
          (record): record is SignalLogRecord & { readonly kind: OutcomeSignalKind } =>
            record.kind === "blocked" || record.kind === "no-op" || record.kind === "story-phase" || record.kind === "adjudicate",
        );
        applyCommitPhaseReset(completedStoryId, signals);
        if (phaseResetApplied) completedStorySnapshot = phaseResolver?.snapshot() ?? completedStorySnapshot;
        const phaseAfter = completedStoryId === undefined
          ? "building"
          : completedStorySnapshot?.phases[completedStoryId] ?? storyState.readPhase(completedStoryId) ?? "building";
        const phaseAtStart = completedStoryId === undefined
          ? "building"
          : phasesAtStepStart?.[completedStoryId] ?? "building";
        const outcome = decideStepOutcome({
          expects: step.expects,
          phaseAtStart,
          phaseAfter,
          signals,
          ...(completedStoryId !== undefined ? { storyId: completedStoryId } : {}),
          reminderSent: outcomeReminderSent,
          ...(attempt.engineBlockReason !== undefined ? { engineBlockReason: attempt.engineBlockReason } : {}),
          remainingBudgetMs: remainingBudget(),
          stepName: step.name,
        });
        expectsPhaseSatisfied = comparePhase(phaseAfter, step.expects) >= 0;
        if (outcome.kind === "remind") {
          if (result.sessionID === undefined) {
            const reason = "outcome reminder unavailable: completed step has no session";
            result = { status: "failed", errorMessage: reason };
            attempt.suppressFailureRetry = true;
            attempt.suppressReason = reason;
            attempt.lastErrorMessage = reason;
            failStepRow(state, currentStepIndex, "failed");
            break;
          }
          outcomeReminderSent = true;
          outcomeReminderPending = true;
          attempt.resumeSessionID = result.sessionID;
          attempt.resumePrompt = outcome.prompt;
          continue;
        }
        if (outcome.kind === "blocked") {
          blockedReason = outcome.reason;
          result = { status: "skipped", ...(result.sessionID !== undefined ? { sessionID: result.sessionID } : {}) };
          failStepRow(state, currentStepIndex, "skipped", { statusMessage: `blocked: ${blockedReason}` });
          logStepLine(currentStepIndex, `[looper] ${step.name} blocked: ${blockedReason}`);
        } else if (outcome.kind === "failed") {
          result = { status: "failed", ...(result.sessionID !== undefined ? { sessionID: result.sessionID } : {}), errorMessage: outcome.reason };
          attempt.suppressFailureRetry = true;
          attempt.suppressReason = outcome.reason;
          attempt.lastErrorMessage = outcome.reason;
          failStepRow(state, currentStepIndex, "failed");
        } else if (outcome.note !== undefined) {
          logStepLine(currentStepIndex, `[looper] ${step.name} outcome: ${outcome.note}`);
        }
      }
      // A repair gets one turn within the existing step budget. Its failure
      // must not be hidden by the preceding successful implementation turn.
      if (branchRepair !== undefined && result.status === "failed") {
        attempt.lastErrorMessage = `branch repair failed: ${result.errorMessage ?? attempt.lastErrorMessage ?? "no result"}`;
        logStepLine(currentStepIndex, `[looper] ${attempt.lastErrorMessage}`);
        break;
      }

      if (result.status === "failed") {
        const errReason = attempt.lastErrorMessage ?? "unknown error (no message reported)";
        const stopRequested = control.quitting || stopFileExists();
        let remainingBudgetMs = remainingBudget();
        let failureDecision = decideAfterFailurePolicy(attempt, { stopRequested, remainingBudgetMs });

        if (failureDecision.kind === "fail") {
          const skipReason = failureDecision.reason;
          logRecoveryBoundary(currentStepIndex, "skip", state.steps[currentStepIndex]?.sessionID, attempt.lastPromptMessageID);
          const line = `[looper] ${step.name} failed: ${errReason} \u2014 not retrying: ${skipReason}`;
          pushAgentLine(state, line);
          pushStepOutputLine(state, currentStepIndex, line);
          if (skipReason === "retry budget exhausted") {
            writeStop?.(`${step.name} failed after retry budget exhausted: ${errReason}`);
          }
          notify();
          break;
        }

        const priorSessionForCheck = state.steps[currentStepIndex]?.sessionID;
        if (
          priorSessionForCheck !== undefined &&
          attempt.lastPromptMessageID !== undefined
        ) {
          let ev = await evaluatePriorSession({
            client,
            repoDir,
            sessionID: priorSessionForCheck,
            messageID: attempt.lastPromptMessageID,
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
              messageID: attempt.lastPromptMessageID,
            });
          }
          const priorEvaluationDecision = decideAfterPriorEvaluation(attempt, {
            evaluation: ev,
            reattachAllowed: {
              sessionID: priorSessionForCheck,
              messageID: attempt.lastPromptMessageID,
            },
          });
          if (priorEvaluationDecision.kind === "leave-session-alone") {
            result = failAfterActivePriorSession(priorSessionForCheck, currentStepIndex, priorEvaluationDecision.reason);
            break;
          }
          if (priorEvaluationDecision.kind === "reattach") {
            attempt.reattachCount += 1;
            const why = priorEvaluationDecision.why;
            pushAgentLine(state, `[looper] ${step.name} reattaching (${attempt.reattachCount}/${MAX_REATTACH_PER_STEP}) to session ${priorSessionForCheck} — ${why}`);
            pushStepOutputLine(state, currentStepIndex, `[looper] ${step.name} reattaching (${attempt.reattachCount}/${MAX_REATTACH_PER_STEP}) to session ${priorSessionForCheck} — ${why}`);
            pendingResult = await reattachOpenCodeStep({
              ctx,
              stepIndex: currentStepIndex,
              client,
              repoDir,
              step,
              sessionID: priorSessionForCheck,
              outcomeMessageID: attempt.lastPromptMessageID,
              timeoutMsOverride: remainingBudget(),
              ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
              ...(questionPolicy !== undefined ? { questionPolicy } : {}),
              ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
              requestBrokerOwner,
            });
            continue;
          }
          if (priorEvaluationDecision.kind === "classify-failure") {
            attempt.lastErrorMessage = priorEvaluationDecision.errorMessage;
          }
        }

        const priorSessionID = state.steps[currentStepIndex]?.sessionID;
        logRecoveryBoundary(currentStepIndex, "retry", priorSessionID, attempt.lastPromptMessageID);

        if (priorSessionID !== undefined) {
          let pending: SessionHealthState = await sessionPendingState(client, repoDir, priorSessionID);
          if (pending === "unknown") pending = await waitForRecoverableHealth(priorSessionID, currentStepIndex);
          let priorHealthDecision: PriorHealthDecision;
          if (pending === "pending") {
            const line = `[looper] ${step.name}: prior session ${priorSessionID} still ${pending}; aborting before retrying`;
            pushAgentLine(state, line);
            pushStepOutputLine(state, currentStepIndex, line);
            notify();
            const stopConfirmed = await stopStepSession(priorSessionID, currentStepIndex);
            priorHealthDecision = decideAfterPriorHealth(attempt, { health: pending, stopConfirmed });
          } else {
            priorHealthDecision = decideAfterPriorHealth(attempt, { health: pending });
          }
          if (priorHealthDecision.kind === "interrupted-health-wait") {
            pendingResult = stopAfterInterruptedHealthWait(priorSessionID, currentStepIndex);
            continue;
          }
          if (priorHealthDecision.kind === "leave-session-alone") {
            result = failAfterUnrecoveredServer(priorSessionID, currentStepIndex);
            break;
          }
          if (priorHealthDecision.kind === "fail-closed") {
            result = failAfterUnconfirmedStop(priorSessionID, currentStepIndex, "retrying in a fresh session");
            break;
          }
        }

        remainingBudgetMs = remainingBudget();
        failureDecision = decideAfterFailurePolicy(attempt, {
          stopRequested: control.quitting || stopFileExists(),
          remainingBudgetMs,
        });
        if (failureDecision.kind === "fail") {
          const skipReason = failureDecision.reason;
          logRecoveryBoundary(currentStepIndex, "skip", state.steps[currentStepIndex]?.sessionID, attempt.lastPromptMessageID);
          const line = `[looper] ${step.name} failed: ${errReason} \u2014 not retrying: ${skipReason}`;
          pushAgentLine(state, line);
          pushStepOutputLine(state, currentStepIndex, line);
          if (skipReason === "retry budget exhausted") {
            writeStop?.(`${step.name} failed after retry budget exhausted: ${errReason}`);
          }
          notify();
          break;
        }
        attempt.failureRetryCount = failureDecision.attempt;
        const delayMs = Math.min(
          applyFailureRetryJitter(failureDecision.delayMs, Math.random() * 2 - 1, failureRetryJitterRatio()),
          Math.max(0, remainingBudgetMs - failureRetryMinRemainingMs()),
        );
        const delaySeconds = Math.round(delayMs / 1000);
        const attemptTag = `attempt ${attempt.failureRetryCount}`;
        const reuseSession = priorSessionID !== undefined;
        const targetSuffix = reuseSession ? "will retry on the existing session" : "will retry with a fresh session";
        const failedStepIndex = currentStepIndex;
        if (reuseSession) {
          attempt.resumeSessionID = priorSessionID;
          attempt.resumePrompt = recoveryNudgePrompt();
        } else {
          currentStepIndex = insertFailureRetryAttempt(state, currentStepIndex);
          stepIndexForTitle = currentStepIndex;
          attempt.resumeSessionID = undefined;
          attempt.resumePrompt = failureRetryPrompt(promptText(step), priorSessionID);
        }
        const waitingLine = `[looper] ${step.name} failed: ${errReason} \u2014 waiting ${delaySeconds}s before retry (${attemptTag}); ${targetSuffix}`;
        pushAgentLine(state, waitingLine);
        pushStepOutputLine(state, failedStepIndex, waitingLine);
        const activeStep = state.steps[currentStepIndex];
        resetStepRowToPending(state, currentStepIndex, { statusMessage: `retry in ${delaySeconds}s` });
        await sleepInterruptible(control, delayMs);
        if (!(control.quitting || stopFileExists() || control.skipRequested || control.restartRequested)) {
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

    } finally {
      mismatchMonitor.stop();
    }

    const phasesAfter =
      adjudication !== undefined ? snapshotPhases(storyState.readPhase, phaseStoryIds) : undefined;
    if (adjudication !== undefined) {
      recordStepTransitions({
        adjudication,
        before: signalPhasesBefore,
        after: phasesAfter,
        iteration,
        stepName: step.name,
        detect: !adjudicating,
        source: "signal",
      });
    }
    try {
      // setsPhase is monotonic only; demotions come from signals / engine reset (Phase B).
      if (
        result.status === "done" &&
        step.setsPhase !== undefined &&
        completedStoryId !== undefined &&
        expectsPhaseSatisfied &&
        !phaseResetApplied
      ) {
        const currentPhase = storyState.readPhase(completedStoryId);
        if (currentPhase === undefined || comparePhase(currentPhase, step.setsPhase) < 0) {
          storyState.writePhase(completedStoryId, step.setsPhase);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sessionID = state.steps[currentStepIndex]?.sessionID;
      failStepRow(state, currentStepIndex, "failed");
      logStepLine(currentStepIndex, `[looper] story phase write failed for ${completedStoryId ?? "current branch"}: ${message}`);
      titleCoordinator?.cancel();
      cancelInheritedTitleTimer();
      requestBrokerOwner.dispose();
      throw new StepFailureError(
        `could not persist story phase for ${completedStoryId ?? "current branch"}: ${message}`,
        { stepName: step.name, ...(sessionID !== undefined ? { sessionID } : {}) },
      );
    }
    if (blockedReason !== undefined && prdPaths !== undefined) {
      const appended = appendBlockedStepToProgress({
        progressPath: resolveProgressFilePath(prdPaths.progress, repoDir),
        stepName: step.name,
        reason: blockedReason,
      });
      if (!appended.appended) logStepLine(currentStepIndex, `[looper] failed to append blocked step to progress: ${appended.error}`);
    }

    const routing = adjudicating ? { kind: "continue" as const } : decideRouting(adjudication);
    if (!adjudicating && routing.kind !== "continue" && result.status !== "done") {
      const terminalSessionID = state.steps[currentStepIndex]?.sessionID;
      if (!(await stopStepSession(terminalSessionID, currentStepIndex)) && terminalSessionID !== undefined) {
        titleCoordinator?.cancel();
        cancelInheritedTitleTimer();
        requestBrokerOwner.dispose();
        throw new StepFailureError(
          `could not confirm session ${terminalSessionID} stopped; deferring adjudication to avoid overlapping opencode generations`,
          { stepName: step.name, sessionID: terminalSessionID },
        );
      }
    }
    applyRouting(routing, currentStepIndex + 1);

    if (result.status === "failed" && routing.kind === "continue" && !adjudicating) {
      titleCoordinator?.cancel();
      cancelInheritedTitleTimer();
      const stopRequested = control.quitting || stopFileExists();
      // Terminal failure (retry exhausted / suppressed / stop requested): make
      // sure the step's session is actually stopped so it doesn't keep running
      // server-side after we surface the failure. Use a short budget when the
      // user is quitting so teardown stays responsive.
      const terminalSessionID = state.steps[currentStepIndex]?.sessionID;
      const terminalStopConfirmed = attempt.allowTerminalSessionToContinue
        ? false
        : await stopStepSession(
            terminalSessionID,
            currentStepIndex,
            stopRequested ? STOP_SESSION_QUIT_TIMEOUT_MS : undefined,
          );
      if ((attempt.allowTerminalSessionToContinue || !terminalStopConfirmed) && terminalSessionID !== undefined) {
        logStepLine(currentStepIndex, `[looper] ${step.name}: session ${terminalSessionID} may still be running after terminal failure`);
      }
      if (stopRequested) {
        markRemainingSkipped(state, currentStepIndex);
        requestBrokerOwner.dispose();
        break;
      }
      const reason = attempt.lastErrorMessage ?? "unknown error (no message reported)";
      requestBrokerOwner.dispose();
      throw new StepFailureError(
        `${step.name} failed after ${attempt.failureRetryCount} retr${attempt.failureRetryCount === 1 ? "y" : "ies"}: ${reason}`,
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
        // Only a completed adjudication resolves the conflict: record the
        // durable completion (before the marker is dropped, so the reason
        // survives for gate scripts), advance the history watermark so the
        // resolved flips no longer count toward detection, then drop the
        // durable adjudication signals.
        if (adjudication !== undefined) {
          adjudication.store.appendCompletion({ at: new Date().toISOString(), reason: adjudication.store.readMarker() ?? "" });
        }
        adjudication?.store.markAdjudicated();
        adjudication?.store.clearMarker();
        adjudication?.store.clearSession();
        requestBrokerOwner.dispose();
        break;
      }
      // Fail closed: keep the marker so the next iteration / resume re-routes
      // to adjudication rather than treating a failed adjudicator as resolved.
      // Confirm its session is stopped first so a retry can't overlap it.
      titleCoordinator?.cancel();
      cancelInheritedTitleTimer();
      const adjSessionID = state.steps[currentStepIndex]?.sessionID;
      if (await stopStepSession(adjSessionID, currentStepIndex)) adjudication?.store.clearSession();
      if (control.quitting || stopFileExists()) {
        markRemainingSkipped(state, currentStepIndex);
        requestBrokerOwner.dispose();
        break;
      }
      requestBrokerOwner.dispose();
      throw new StepFailureError(
        `adjudicate step failed: ${attempt.lastErrorMessage ?? "adjudicator did not complete"}`,
        { stepName: step.name, ...(adjSessionID !== undefined ? { sessionID: adjSessionID } : {}) },
      );
    }

    const routed = routing.kind !== "continue";
    finalizeLogicalStep({
      status: result.status,
      completionKind: blockedReason !== undefined ? "blocked" : result.status === "done" ? "done" : "runtime-skip",
      nextIndex: routed ? steps.length : index + 1,
      rowIndex: currentStepIndex,
      recordPriorStep: true,
      ...(blockedReason !== undefined ? { priorStatus: `blocked (${blockedReason})` } : {}),
    });
    requestBrokerOwner.dispose();
  }

  return control.quitting || control.stopAfterIteration || stopFileExists() || stopAfterIterationFileExists()
    ? "stopped"
    : "complete";
}
