import { existsSync, readFileSync } from "node:fs";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { loadSteps } from "./config.ts";
import {
  evaluatePriorSession,
  reattachOpenCodeStep,
  runOpenCodeStep,
  waitForLoopContinuationIdle,
  type Step,
  type StepResult,
  type StepRunResult,
} from "./runner.ts";
import { notify, pushAgentLine, pushStepOutputLine, type LoopState, type LoopStep } from "./state.ts";
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
  state.steps = cfgSteps.map((step, j) => {
    if (j < nextIndex) {
      const prev = completed[j];
      if (prev && prev.name === step.name) return { ...prev };
      return { name: step.name, status: "skipped" as const, finishedAt: Date.now(), outputLines: [], outputLineTimes: [], outputScrollTop: 0, outputPinnedToBottom: true };
    }
    return { name: step.name, status: "pending" as const, outputLines: [], outputLineTimes: [], outputScrollTop: 0, outputPinnedToBottom: true };
  });
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

class TitleCoordinator {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<string | undefined> | undefined;
  private readonly controller = new AbortController();
  private firstFired = false;
  private finished = false;

  constructor(
    private readonly client: OpencodeClient,
    private readonly repoDir: string,
    private readonly delaySeconds: number | undefined,
    private readonly getSessionID: () => string | undefined,
    private readonly log: (line: string) => void,
  ) {}

  readonly onFirstResponse = (): void => {
    if (this.firstFired || this.finished) return;
    this.firstFired = true;
    if (this.delaySeconds === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const sid = this.getSessionID();
      if (sid === undefined) return;
      this.inflight = this.snapshotAndGenerate(sid);
    }, this.delaySeconds * 1000);
  };

  async resolve(finalSessionID: string): Promise<string | undefined> {
    this.finished = true;
    this.clearTimer();
    if (this.inflight !== undefined) {
      const fromTimer = await this.inflight;
      if (fromTimer !== undefined) return fromTimer;
    }
    return await this.snapshotAndGenerate(finalSessionID);
  }

  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();
    this.controller.abort();
    this.inflight = undefined;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async snapshotAndGenerate(sessionID: string): Promise<string | undefined> {
    try {
      const messages = await this.client.session.messages(
        { sessionID, directory: this.repoDir },
        { signal: this.controller.signal },
      );
      if (messages.error || !messages.data) return undefined;
      const text = extractAssistantText(messages.data);
      if (text.length === 0) return undefined;
      return await generateWorkDescription({
        client: this.client,
        repoDir: this.repoDir,
        contextText: text,
        signal: this.controller.signal,
        log: this.log,
      });
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

    if (stopFileExists() || state.quitting) {
      markRemainingSkipped(state, index);
      break;
    }

    await waitWhilePaused(state);

    if (stopFileExists() || state.quitting) {
      markRemainingSkipped(state, index);
      break;
    }

    hooks?.onStepBegin?.({ step: steps[index]!, index, totalSteps: steps.length, iteration });

    const step = steps[index]!;

    const titleConfig = step.title;
    const stepIndexForTitle = index;
    const titleLog = (line: string) => {
      pushAgentLine(state, line);
      pushStepOutputLine(state, stepIndexForTitle, line);
      notify();
    };
    const titleCoordinator =
      titleConfig === undefined || titleConfig === false
        ? undefined
        : new TitleCoordinator(
            client,
            repoDir,
            typeof titleConfig === "number" ? titleConfig : undefined,
            () => state.steps[stepIndexForTitle]?.sessionID,
            titleLog,
          );

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
    while (true) {
      if (pendingResult !== undefined) {
        result = pendingResult;
        pendingResult = undefined;
      } else {
        result = await runOpenCodeStep({
          state,
          stepIndex: index,
          prompt: resumePrompt ?? promptText(step),
          client,
          repoDir,
          step,
          sessionID: resumeSessionID,
          ...(titleCoordinator ? { onFirstAssistantContent: titleCoordinator.onFirstResponse } : {}),
        });
      }
      resumePrompt = undefined;
      state.skipRequested = false;
      state.restartRequested = false;
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
          pushStepOutputLine(state, index, line);
          const activeStep = state.steps[index];
          if (activeStep) {
            activeStep.status = "failed";
            activeStep.statusMessage = undefined;
            activeStep.finishedAt = Date.now();
          }
          state.activeStepIndex = null;
          notify();
          break;
        }

        const waitResult = await waitForLoopContinuationIdle({ state, client, stepIndex: index, repoDir, sessionID: waitSessionID });
        if (waitResult === "idle" && !state.quitting && !stopFileExists()) {
          resumeSessionID = waitSessionID;
          resumePrompt = backgroundContinuationPrompt();
          pushAgentLine(state, `[looper] background tasks idle; resuming session ${resumeSessionID}`);
          pushStepOutputLine(state, index, `[looper] background tasks idle; resuming session ${resumeSessionID}`);
          notify();
          continue;
        }

        if (waitResult === "restart") {
          resumeSessionID = state.steps[index]?.sessionID;
          pushAgentLine(state, `[looper] restart requested during background wait for session ${waitSessionID}`);
          pushStepOutputLine(state, index, `[looper] restart requested during background wait for session ${waitSessionID}`);
          const activeStep = state.steps[index];
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
        const activeStep = state.steps[index];
        if (activeStep) {
          activeStep.status = result.status === "skipped" ? "skipped" : "failed";
          activeStep.statusMessage = undefined;
          activeStep.finishedAt = Date.now();
        }
        state.activeStepIndex = null;
        pushAgentLine(state, `[looper] background task wait ended with ${waitResult} for session ${waitSessionID}`);
        pushStepOutputLine(state, index, `[looper] background task wait ended with ${waitResult} for session ${waitSessionID}`);
        notify();
      }

      if (result.status === "restart" && !state.quitting && !stopFileExists()) {
        resumeSessionID = state.steps[index]?.sessionID;
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
          pushStepOutputLine(state, index, line);
          notify();
          break;
        }

        const priorSessionForCheck = state.steps[index]?.sessionID;
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
            pushStepOutputLine(state, index, `[looper] ${step.name} reattaching (${reattachCount}/${MAX_REATTACH_PER_STEP}) to session ${priorSessionForCheck} — ${why}`);
            pendingResult = await reattachOpenCodeStep({
              state,
              stepIndex: index,
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
        const priorSessionID = state.steps[index]?.sessionID;
        const hasOutput = (state.steps[index]?.outputLines.length ?? 0) > 0;
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
        pushStepOutputLine(state, index, waitingLine);
        const activeStep = state.steps[index];
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
          pushStepOutputLine(state, index, retryingLine);
          if (activeStep) activeStep.statusMessage = undefined;
          notify();
        }
        continue;
      }

      break;
    }

    if (result.status === "failed") {
      titleCoordinator?.cancel();
      if (state.quitting || stopFileExists()) {
        markRemainingSkipped(state, index);
        break;
      }
      const reason = lastErrorMessage ?? "unknown error (no message reported)";
      throw new StepFailureError(
        `${step.name} failed after ${failureRetryCount} retr${failureRetryCount === 1 ? "y" : "ies"}: ${reason}`,
      );
    }

    if (result.status === "done" && result.sessionID !== undefined) {
      if (titleCoordinator !== undefined) {
        const desc = await titleCoordinator.resolve(result.sessionID);
        if (desc !== undefined) {
          workDescription = desc;
          await setSessionTitle({
            client,
            repoDir,
            sessionID: result.sessionID,
            title: `${step.name}: ${desc}`,
            log: titleLog,
          });
        }
      } else if (workDescription !== undefined) {
        await setSessionTitle({
          client,
          repoDir,
          sessionID: result.sessionID,
          title: `${step.name}: ${workDescription}`,
          log: titleLog,
        });
      }
    } else {
      titleCoordinator?.cancel();
    }

    hooks?.onStepFinish?.({ step, index, nextIndex: index + 1, totalSteps: steps.length, iteration, status: result.status });

    const snapshot = state.steps[index];
    if (snapshot) completed[index] = { ...snapshot };

    index += 1;
  }

  return state.quitting || state.stopAfterIteration || stopFileExists() || stopAfterIterationFileExists()
    ? "stopped"
    : "complete";
}
