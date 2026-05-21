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
const MAX_FAILURE_RETRIES_PER_STEP = 10;
const MAX_REATTACH_PER_STEP = 5;

function backgroundContinuationPrompt(): string {
  return "Background agents are done. Check their results, incorporate what you learned, and continue this step until it is complete. If more background tasks are needed, wait for them before reporting completion.\n";
}

function failureResumePrompt(): string {
  return "The previous attempt at this step failed before reporting completion. Resume from where you left off, recover from whatever error occurred, and finish the step. If the same error recurs, switch to a different approach.\n";
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
        if (hasOutput && priorSessionID !== undefined) {
          resumeSessionID = priorSessionID;
          resumePrompt = failureResumePrompt();
          pushAgentLine(state, `[looper] ${step.name} failed: ${errReason} \u2014 retrying (attempt ${failureRetryCount}/${MAX_FAILURE_RETRIES_PER_STEP}); resuming session ${priorSessionID}`);
          pushStepOutputLine(state, index, `[looper] ${step.name} failed: ${errReason} \u2014 retrying (attempt ${failureRetryCount}/${MAX_FAILURE_RETRIES_PER_STEP}); resuming session ${priorSessionID}`);
        } else {
          resumeSessionID = undefined;
          resumePrompt = undefined;
          pushAgentLine(state, `[looper] ${step.name} failed: ${errReason} \u2014 retrying (attempt ${failureRetryCount}/${MAX_FAILURE_RETRIES_PER_STEP}); restarting with a fresh session`);
          pushStepOutputLine(state, index, `[looper] ${step.name} failed: ${errReason} \u2014 retrying (attempt ${failureRetryCount}/${MAX_FAILURE_RETRIES_PER_STEP}); restarting with a fresh session`);
        }
        const activeStep = state.steps[index];
        if (activeStep) {
          activeStep.status = "pending";
          activeStep.statusMessage = undefined;
          activeStep.finishedAt = undefined;
        }
        notify();
        continue;
      }

      break;
    }

    if (result.status === "failed") {
      if (state.quitting || stopFileExists()) {
        markRemainingSkipped(state, index);
        break;
      }
      const reason = lastErrorMessage ?? "unknown error (no message reported)";
      throw new Error(
        `${step.name} failed after ${failureRetryCount} retr${failureRetryCount === 1 ? "y" : "ies"}: ${reason}`,
      );
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
