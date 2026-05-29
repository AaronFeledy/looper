import { existsSync, readFileSync } from "node:fs";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { loadSteps } from "./config.ts";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  evaluatePriorSession,
  reattachOpenCodeStep,
  runOpenCodeStep,
  waitForLoopContinuationIdle,
  type Step,
  type StepResult,
  type StepRunResult,
} from "./runner.ts";
import { insertRestartAttempt, notify, pushAgentLine, pushStepOutputLine, type LoopState, type LoopStep, type StepRestartReason } from "./state.ts";
import { stopAfterIterationFileExists, stopFileExists } from "./state-files.ts";
import { extractAssistantText, generateWorkDescription, setSessionTitle } from "./title.ts";

function textEndsWithNewline(text: string): boolean {
  return text.endsWith("\n");
}

function fileEndsWithNewline(path: string): boolean {
  if (!existsSync(path)) return false;
  const content = readFileSync(path);
  return content.length === 0 || content[content.length - 1] === 0x0a;
}

export function promptText(step: Step): string {
  if (!existsSync(step.prompt)) throw new Error(`missing prompt file for ${step.name}: ${step.prompt}`);

  const parts: string[] = [];
  if (step.prefix) {
    parts.push(step.prefix);
    parts.push(textEndsWithNewline(step.prefix) ? "\n" : "\n\n");
  }

  parts.push(readFileSync(step.prompt, "utf8"));

  if (step.suffix) {
    parts.push(fileEndsWithNewline(step.prompt) ? "\n" : "\n\n");
    parts.push(step.suffix);
    if (!textEndsWithNewline(step.suffix)) parts.push("\n");
  }

  return parts.join("");
}

function syncStepsUiState(state: LoopState, cfgSteps: Step[], nextIndex: number, completed: LoopStep[]): void {
  const rows: LoopStep[] = completed.map((step) => ({ ...step }));
  if (rows.length === 0 && nextIndex > 0) {
    for (let j = 0; j < nextIndex; j += 1) {
      const step = cfgSteps[j];
      if (!step) continue;
      rows.push({ name: step.name, status: "skipped" as const, finishedAt: Date.now(), outputLines: [], outputLineTimes: [], outputScrollTop: 0, outputPinnedToBottom: true, backgroundAgents: [] });
    }
  }
  for (let j = nextIndex; j < cfgSteps.length; j += 1) {
    const step = cfgSteps[j];
    if (!step) continue;
    rows.push({ name: step.name, status: "pending" as const, outputLines: [], outputLineTimes: [], outputScrollTop: 0, outputPinnedToBottom: true, backgroundAgents: [] });
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
  onStepBegin?: (info: { step: Step; index: number; totalSteps: number; iteration: number }) => void;
  onStepFinish?: (info: { step: Step; index: number; nextIndex: number; totalSteps: number; iteration: number; status: StepResult }) => void;
};

export type RunIterationOptions = {
  state: LoopState;
  iteration: number;
  client: OpencodeClient;
  repoDir: string;
  configDir: string;
  startStepIndex?: number;
  hooks?: RunIterationHooks;
};

async function waitWhilePaused(state: LoopState): Promise<void> {
  while (state.paused && !state.quitting && !stopFileExists()) {
    await Bun.sleep(100);
  }
}

const MAX_BACKGROUND_RESUMES_PER_STEP = 10;
const MAX_FAILURE_RETRIES_PER_STEP = 2;
const MAX_REATTACH_PER_STEP = 5;
const FAILURE_RETRY_BASE_DELAY_MS = 2000;
const FAILURE_RETRY_MAX_DELAY_MS = 30_000;

function failureRetryDelayMs(attempt: number): number {
  const exp = FAILURE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(exp, FAILURE_RETRY_MAX_DELAY_MS);
}

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
  constructor(message: string) {
    super(message);
    this.name = "StepFailureError";
  }
}

function backgroundContinuationPrompt(): string {
  return "Background agents are done. Check their results, incorporate what you learned, and continue this step until it is complete. If more background tasks are needed, wait for them before reporting completion.\n";
}

function failureResumePrompt(): string {
  return "The previous attempt at this step failed before reporting completion. Resume from where you left off, recover from whatever error occurred, and finish the step. If the same error recurs, switch to a different approach.\n";
}

function cleanRestartPrompt(step: Step, reason: StepRestartReason): string {
  const label = reason === "timeout" ? "timed out" : "was manually restarted";
  return `Note: This is a clean restart in a new session because the previous attempt ${label}. The previous attempt may have been interrupted after making partial progress, so inspect the existing workspace/state and continue from any useful work rather than blindly starting over.\n\n${promptText(step)}`;
}

/**
 * Branch names that don't carry useful information for titling. Filtered out
 * before they reach the title prompt so the model isn't tempted to summarize
 * an iteration as "Main" / "Master".
 */
const TRIVIAL_BRANCH_NAMES = new Set(["main", "master", "dev", "develop", "trunk", "default", "unknown", "detached"]);

function branchHintFor(branch: string | undefined): string | undefined {
  if (branch === undefined) return undefined;
  const trimmed = branch.trim();
  if (trimmed.length === 0) return undefined;
  if (TRIVIAL_BRANCH_NAMES.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

/**
 * Fallback delay for `title: branch` mode when no branch transition is
 * observed during the step. Matches the spirit of `title: 300`.
 */
const BRANCH_FALLBACK_SECONDS = 300;

/**
 * Delay between a step's first assistant response and the opencode
 * `session.update` rename for steps that inherited a title from an earlier
 * step in the same iteration. Lets the new step prove it's actually producing
 * content (avoids racing the rename against the create) without waiting for
 * step end &mdash; opencode would otherwise auto-title from the step prompt.
 * Override with `LOOPER_INHERITED_TITLE_DELAY_MS` (tests use this).
 */
function inheritedRenameDelayMs(): number {
  const raw = Number(process.env["LOOPER_INHERITED_TITLE_DELAY_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

/**
 * How often the branch-mode coordinator re-reads `state.branch` looking for a
 * transition. Branch changes don't need ms-grained detection; 500ms keeps the
 * latency low without burning measurable CPU.
 */
const BRANCH_POLL_INTERVAL_MS = 500;

type TitleMode =
  | { kind: "end" }
  | { kind: "delay"; seconds: number }
  | { kind: "branch"; fallbackSeconds: number };

function titleModeFor(cfg: boolean | number | "branch"): TitleMode | undefined {
  if (cfg === false) return undefined;
  if (cfg === true) return { kind: "end" };
  if (cfg === "branch") return { kind: "branch", fallbackSeconds: BRANCH_FALLBACK_SECONDS };
  return { kind: "delay", seconds: cfg };
}

class TitleCoordinator {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private branchPollTimer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<string | undefined> | undefined;
  private readonly controller = new AbortController();
  private firstFired = false;
  private finished = false;
  private applied = false;
  private appliedToSessionID: string | undefined;
  private readonly initialBranch: string | undefined;

  constructor(
    private readonly client: OpencodeClient,
    private readonly repoDir: string,
    private readonly mode: TitleMode,
    private readonly getSessionID: () => string | undefined,
    private readonly getBranch: () => string | undefined,
    /** Apply the generated title (state mutation + opencode session.update). Called eagerly the moment generation succeeds, NOT at step end — so TUI and opencode update mid-step. */
    private readonly applyTitle: (desc: string) => Promise<void>,
    private readonly log: (line: string) => void,
  ) {
    this.initialBranch = mode.kind === "branch" ? getBranch() : undefined;
    if (mode.kind === "branch") {
      this.branchPollTimer = setInterval(() => this.checkBranchChange(), BRANCH_POLL_INTERVAL_MS);
    }
  }

  readonly onFirstResponse = (): void => {
    if (this.firstFired || this.finished) return;
    this.firstFired = true;
    const delaySeconds =
      this.mode.kind === "delay"
        ? this.mode.seconds
        : this.mode.kind === "branch"
          ? this.mode.fallbackSeconds
          : undefined;
    if (delaySeconds === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.inflight !== undefined) return;
      const sid = this.getSessionID();
      if (sid === undefined) return;
      this.inflight = this.runGeneration(sid);
    }, delaySeconds * 1000);
  };

  async resolve(finalSessionID: string): Promise<string | undefined> {
    this.finished = true;
    this.clearTimers();
    if (this.inflight !== undefined) {
      const fromTimer = await this.inflight;
      if (fromTimer !== undefined) {
        // Title was generated and applied mid-step, but if the step retried
        // with a new session, we need to re-apply the title to the final session.
        if (this.appliedToSessionID !== undefined && this.appliedToSessionID !== finalSessionID) {
          try {
            await this.applyTitle(fromTimer);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log(`[looper] title gen: re-apply to retry session threw: ${message}`);
          }
        }
        return fromTimer;
      }
    }
    return await this.runGeneration(finalSessionID);
  }

  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    this.controller.abort();
    this.inflight = undefined;
  }

  private checkBranchChange(): void {
    if (this.finished || this.inflight !== undefined) return;
    const current = this.getBranch();
    if (current === undefined || current === this.initialBranch) return;
    const hint = branchHintFor(current);
    if (hint === undefined) return;
    const sid = this.getSessionID();
    if (sid === undefined) return; // session not bound yet; try again next tick
    this.clearBranchPoll();
    this.log(`[looper] title gen: branch changed to ${hint}; firing title now`);
    this.inflight = this.runGeneration(sid);
  }

  private clearTimers(): void {
    this.clearTimer();
    this.clearBranchPoll();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private clearBranchPoll(): void {
    if (this.branchPollTimer !== undefined) {
      clearInterval(this.branchPollTimer);
      this.branchPollTimer = undefined;
    }
  }

  private async runGeneration(sessionID: string): Promise<string | undefined> {
    try {
      const messages = await this.client.session.messages(
        { sessionID, directory: this.repoDir },
        { signal: this.controller.signal },
      );
      if (messages.error || !messages.data) return undefined;
      const text = extractAssistantText(messages.data);
      const branchHint = branchHintFor(this.getBranch());
      // Skip generation only if BOTH signals are empty. A useful branch alone
      // is enough to produce a good title even before the assistant has said
      // anything substantive.
      if (text.length === 0 && branchHint === undefined) return undefined;
      const desc = await generateWorkDescription({
        client: this.client,
        repoDir: this.repoDir,
        contextText: text,
        ...(branchHint !== undefined ? { branchHint } : {}),
        signal: this.controller.signal,
        log: this.log,
      });
      if (desc !== undefined && !this.applied) {
        this.applied = true;
        this.appliedToSessionID = sessionID;
        try {
          await this.applyTitle(desc);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`[looper] title gen: applyTitle threw: ${message}`);
        }
      }
      return desc;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[looper] title gen snapshot threw: ${message}`);
      return undefined;
    }
  }
}

export async function runIteration({
  state,
  iteration,
  client,
  repoDir,
  configDir,
  startStepIndex = 0,
  hooks,
}: RunIterationOptions): Promise<"complete" | "stopped"> {
  const completed: LoopStep[] = [];
  let index = Math.max(0, startStepIndex);
  let startStepIndexApplied = false;
  let workDescription: string | undefined;

  while (true) {
    const steps = loadSteps(configDir);
    if (steps.length === 0) throw new Error("loop.yaml must define at least one step");
    if (!startStepIndexApplied) {
      index = Math.min(index, steps.length - 1);
      startStepIndexApplied = true;
    }

    if (index >= steps.length) break;

    syncStepsUiState(state, steps, index, completed);
    let currentStepIndex = state.steps.length - (steps.length - index);

    if (stopFileExists() || state.quitting) {
      markRemainingSkipped(state, currentStepIndex);
      break;
    }

    await waitWhilePaused(state);

    if (stopFileExists() || state.quitting) {
      markRemainingSkipped(state, currentStepIndex);
      break;
    }

    hooks?.onStepBegin?.({ step: steps[index]!, index, totalSteps: steps.length, iteration });

    const step = steps[index]!;

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
    const applyTitle = async (desc: string): Promise<void> => {
      workDescription = desc;
      const row = state.steps[stepIndexForTitle];
      if (row && row.title !== desc) {
        row.title = desc;
        notify();
      }
      const sid = state.steps[stepIndexForTitle]?.sessionID;
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
            () => state.steps[stepIndexForTitle]?.sessionID,
            () => state.branch,
            applyTitle,
            titleLog,
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
    let inheritedTitleApplied = false;
    let inheritedTitleTimer: ReturnType<typeof setTimeout> | undefined;
    let inheritedTitleInflight: Promise<void> | undefined;
    const applyInheritedOpencodeTitle = async (): Promise<void> => {
      if (inheritedTitleApplied) return;
      inheritedTitleApplied = true;
      const sid = state.steps[stepIndexForTitle]?.sessionID;
      if (sid === undefined || workDescription === undefined) return;
      await setSessionTitle({
        client,
        repoDir,
        sessionID: sid,
        title: `${step.name}: ${workDescription}`,
        log: titleLog,
      });
    };
    const onInheritedFirstResponse = (): void => {
      if (inheritedTitleApplied || inheritedTitleTimer !== undefined) return;
      inheritedTitleTimer = setTimeout(() => {
        inheritedTitleTimer = undefined;
        inheritedTitleInflight = applyInheritedOpencodeTitle();
      }, inheritedRenameDelayMs());
    };
    const cancelInheritedTitleTimer = (): void => {
      if (inheritedTitleTimer !== undefined) {
        clearTimeout(inheritedTitleTimer);
        inheritedTitleTimer = undefined;
      }
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
    let failureRetryCount = 0;
    let reattachCount = 0;
    let resumeSessionID: string | undefined;
    let resumePrompt: string | undefined;
    let backgroundResumeCount = 0;
    let lastErrorMessage: string | undefined;
    let lastPromptMessageID: string | undefined;
    let stepStartTime = Date.now();
    while (true) {
      if (pendingResult !== undefined) {
        result = pendingResult;
        pendingResult = undefined;
      } else {
        result = await runOpenCodeStep({
          state,
          stepIndex: currentStepIndex,
          prompt: resumePrompt ?? promptText(step),
          client,
          repoDir,
          step,
          sessionID: resumeSessionID,
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
        if (backgroundResumeCount > MAX_BACKGROUND_RESUMES_PER_STEP) {
          result = { status: "failed" };
          suppressFailureRetry = true;
          suppressReason = `background task resume limit (${MAX_BACKGROUND_RESUMES_PER_STEP}) exceeded for session ${waitSessionID}`;
          lastErrorMessage = lastErrorMessage ?? suppressReason;
          const line = `[looper] background task resume limit exceeded for session ${waitSessionID}`;
          pushAgentLine(state, line);
          pushStepOutputLine(state, currentStepIndex, line);
          const activeStep = state.steps[currentStepIndex];
          if (activeStep) {
            activeStep.status = "failed";
            activeStep.statusMessage = undefined;
            activeStep.finishedAt = Date.now();
          }
          state.activeStepIndex = null;
          notify();
          break;
        }

        const budget = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
        const remainingMs = Math.max(0, budget - (Date.now() - stepStartTime));
        const waitResult = await waitForLoopContinuationIdle({ state, client, stepIndex: currentStepIndex, repoDir, sessionID: waitSessionID, timeoutMs: remainingMs });
        if (waitResult === "idle" && !state.quitting && !stopFileExists()) {
          resumeSessionID = waitSessionID;
          resumePrompt = backgroundContinuationPrompt();
          pushAgentLine(state, `[looper] background tasks idle; resuming session ${resumeSessionID}`);
          pushStepOutputLine(state, currentStepIndex, `[looper] background tasks idle; resuming session ${resumeSessionID}`);
          notify();
          continue;
        }

        if (waitResult === "restart") {
          const reason: StepRestartReason = state.restartReason ?? "manual";
          const previousStepIndex = currentStepIndex;
          currentStepIndex = insertRestartAttempt(state, currentStepIndex, reason);
          stepIndexForTitle = currentStepIndex;
          stepStartTime = Date.now();
          resumeSessionID = undefined;
          resumePrompt = cleanRestartPrompt(step, reason);
          pushAgentLine(state, `[looper] restart requested during background wait for session ${waitSessionID}`);
          pushStepOutputLine(state, previousStepIndex, `[looper] restart requested during background wait for session ${waitSessionID}`);
          state.restartRequested = false;
          state.restartReason = undefined;
          const activeStep = state.steps[currentStepIndex];
          if (activeStep) {
            activeStep.status = "pending";
            activeStep.statusMessage = undefined;
            activeStep.finishedAt = undefined;
          }
          notify();
          continue;
        }

        if (waitResult === "timeout") {
          const previousStepIndex = currentStepIndex;
          currentStepIndex = insertRestartAttempt(state, currentStepIndex, "timeout");
          stepIndexForTitle = currentStepIndex;
          stepStartTime = Date.now();
          resumeSessionID = undefined;
          resumePrompt = cleanRestartPrompt(step, "timeout");
          pushAgentLine(state, `[looper] timeout restarting ${step.name} after background wait for session ${waitSessionID}`);
          pushStepOutputLine(state, previousStepIndex, `[looper] timeout restarting ${step.name} after background wait for session ${waitSessionID}`);
          const activeStep = state.steps[currentStepIndex];
          if (activeStep) {
            activeStep.status = "pending";
            activeStep.statusMessage = undefined;
            activeStep.finishedAt = undefined;
          }
          notify();
          continue;
        }

        const skipLike = waitResult === "stopped" || waitResult === "skipped";
        result = { status: skipLike ? "skipped" : "failed" };
        if (!skipLike) {
          suppressFailureRetry = true;
          suppressReason = `background task wait ended with ${waitResult} for session ${waitSessionID}`;
          lastErrorMessage = lastErrorMessage ?? suppressReason;
        }
        const activeStep = state.steps[currentStepIndex];
        if (activeStep) {
          activeStep.status = result.status === "skipped" ? "skipped" : "failed";
          activeStep.statusMessage = undefined;
          activeStep.finishedAt = Date.now();
        }
        state.activeStepIndex = null;
        pushAgentLine(state, `[looper] background task wait ended with ${waitResult} for session ${waitSessionID}`);
        pushStepOutputLine(state, currentStepIndex, `[looper] background task wait ended with ${waitResult} for session ${waitSessionID}`);
        notify();
      }

      if (result.status === "restart" && !state.quitting && !stopFileExists()) {
        const reason = result.restartReason ?? requestedRestartReason ?? "manual";
        currentStepIndex = insertRestartAttempt(state, currentStepIndex, reason);
        stepIndexForTitle = currentStepIndex;
        stepStartTime = Date.now();
        resumeSessionID = undefined;
        resumePrompt = cleanRestartPrompt(step, reason);
        continue;
      }

      if (result.status === "failed") {
        const errReason = lastErrorMessage ?? "unknown error (no message reported)";
        const stopRequested = state.quitting || stopFileExists();
        let skipReason: string | undefined;
        if (suppressFailureRetry) skipReason = `retry suppressed (${suppressReason ?? "background-wait outcome"})`;
        else if (failureRetryCount >= MAX_FAILURE_RETRIES_PER_STEP) skipReason = `retry limit reached (${MAX_FAILURE_RETRIES_PER_STEP})`;
        else if (stopRequested) skipReason = "stop requested";

        if (skipReason !== undefined) {
          const line = `[looper] ${step.name} failed: ${errReason} \u2014 not retrying: ${skipReason}`;
          pushAgentLine(state, line);
          pushStepOutputLine(state, currentStepIndex, line);
          notify();
          break;
        }

        const priorSessionForCheck = state.steps[currentStepIndex]?.sessionID;
        if (
          priorSessionForCheck !== undefined &&
          lastPromptMessageID !== undefined &&
          reattachCount < MAX_REATTACH_PER_STEP
        ) {
          const ev = await evaluatePriorSession({
            client,
            repoDir,
            sessionID: priorSessionForCheck,
            messageID: lastPromptMessageID,
          });
          const shouldReattach =
            ev.pending ||
            ev.classification.kind === "done" ||
            ev.classification.kind === "in-progress";
          if (shouldReattach) {
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
              messageID: lastPromptMessageID,
            });
            continue;
          }
          if (ev.classification.kind === "failed") {
            lastErrorMessage = ev.classification.errorMessage;
          }
        }

        failureRetryCount += 1;
        const priorSessionID = state.steps[currentStepIndex]?.sessionID;
        const hasOutput = (state.steps[currentStepIndex]?.outputLines.length ?? 0) > 0;
        const delayMs = failureRetryDelayMs(failureRetryCount);
        const delaySeconds = Math.round(delayMs / 1000);
        const attemptTag = `attempt ${failureRetryCount}/${MAX_FAILURE_RETRIES_PER_STEP}`;
        const targetSuffix =
          hasOutput && priorSessionID !== undefined
            ? `will resume session ${priorSessionID}`
            : `will restart with a fresh session`;
        if (hasOutput && priorSessionID !== undefined) {
          resumeSessionID = priorSessionID;
          resumePrompt = failureResumePrompt();
        } else {
          resumeSessionID = undefined;
          resumePrompt = undefined;
        }
        const waitingLine = `[looper] ${step.name} failed: ${errReason} \u2014 waiting ${delaySeconds}s before retry (${attemptTag}); ${targetSuffix}`;
        pushAgentLine(state, waitingLine);
        pushStepOutputLine(state, currentStepIndex, waitingLine);
        const activeStep = state.steps[currentStepIndex];
        if (activeStep) {
          activeStep.status = "pending";
          activeStep.statusMessage = `retry in ${delaySeconds}s`;
          activeStep.finishedAt = undefined;
        }
        notify();
        await sleepInterruptible(state, delayMs);
        if (!(state.quitting || stopFileExists() || state.skipRequested || state.restartRequested)) {
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

    if (result.status === "failed") {
      titleCoordinator?.cancel();
      cancelInheritedTitleTimer();
      if (state.quitting || stopFileExists()) {
        markRemainingSkipped(state, currentStepIndex);
        break;
      }
      const reason = lastErrorMessage ?? "unknown error (no message reported)";
      throw new StepFailureError(
        `${step.name} failed after ${failureRetryCount} retr${failureRetryCount === 1 ? "y" : "ies"}: ${reason}`,
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
        if (inheritedTitleInflight !== undefined) {
          await inheritedTitleInflight;
        } else {
          await applyInheritedOpencodeTitle();
        }
      }
    } else {
      titleCoordinator?.cancel();
      cancelInheritedTitleTimer();
    }

    hooks?.onStepFinish?.({ step, index, nextIndex: index + 1, totalSteps: steps.length, iteration, status: result.status });

    completed.splice(0, completed.length, ...state.steps.slice(0, currentStepIndex + 1).map((step) => ({ ...step })));

    index += 1;
  }

  return state.quitting || state.stopAfterIteration || stopFileExists() || stopAfterIterationFileExists()
    ? "stopped"
    : "complete";
}
