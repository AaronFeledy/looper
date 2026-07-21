import type { PriorSessionEvaluation, SessionHealthState } from "./session-types.ts";
import {
  MAX_REATTACH_PER_STEP,
  nextActionForFailure,
  shouldEvaluatePriorSessionForReattach,
  type FailureRetryDecision,
} from "./retry-policy.ts";

export type StepAttemptState = {
  suppressFailureRetry: boolean;
  suppressReason: string | undefined;
  allowTerminalSessionToContinue: boolean;
  failureRetryCount: number;
  reattachCount: number;
  backgroundResumeCount: number;
  orphanNudgeCount: number;
  recoveryNudgeActive: boolean;
  resumeSessionID: string | undefined;
  resumePrompt: string | undefined;
  lastErrorMessage: string | undefined;
  lastPromptMessageID: string | undefined;
};

export type PriorEvaluationDecision =
  | { readonly kind: "reattach"; readonly why: string }
  | { readonly kind: "classify-failure"; readonly errorMessage: string }
  | { readonly kind: "retry-fresh" }
  | { readonly kind: "leave-session-alone"; readonly reason: string };

export type PriorHealthDecision =
  | { readonly kind: "retry-fresh" }
  | { readonly kind: "fail-closed" }
  | { readonly kind: "leave-session-alone" }
  | { readonly kind: "interrupted-health-wait" };

type PriorHealthInput =
  | { readonly health: Exclude<SessionHealthState, "pending">; readonly stopConfirmed?: never }
  | { readonly health: "pending"; readonly stopConfirmed: boolean };

export function createStepAttemptState(): StepAttemptState {
  return {
    suppressFailureRetry: false,
    suppressReason: undefined,
    allowTerminalSessionToContinue: false,
    failureRetryCount: 0,
    reattachCount: 0,
    backgroundResumeCount: 0,
    orphanNudgeCount: 0,
    recoveryNudgeActive: false,
    resumeSessionID: undefined,
    resumePrompt: undefined,
    lastErrorMessage: undefined,
    lastPromptMessageID: undefined,
  };
}

export function decideAfterFailurePolicy(
  attempt: Readonly<StepAttemptState>,
  input: { readonly stopRequested: boolean },
): FailureRetryDecision {
  return nextActionForFailure({
    failureRetryCount: attempt.failureRetryCount,
    suppressFailureRetry: attempt.suppressFailureRetry,
    ...(attempt.suppressReason !== undefined ? { suppressReason: attempt.suppressReason } : {}),
    stopRequested: input.stopRequested,
  });
}

export function decideAfterPriorEvaluation(
  attempt: Readonly<StepAttemptState>,
  input: {
    readonly evaluation: PriorSessionEvaluation;
    readonly reattachAllowed: {
      readonly sessionID: string | undefined;
      readonly messageID: string | undefined;
    };
  },
): PriorEvaluationDecision {
  const evaluation = input.evaluation;
  const live = evaluation.pending || evaluation.classification.kind === "done" || evaluation.classification.kind === "in-progress";
  if (live) {
    const allowed = shouldEvaluatePriorSessionForReattach({
      ...input.reattachAllowed,
      reattachCount: attempt.reattachCount,
    });
    if (!allowed) {
      let reason: string;
      if (evaluation.pending) {
        reason = `reattach limit (${MAX_REATTACH_PER_STEP}) reached while session is still busy on opencode side`;
      } else if (evaluation.classification.kind === "in-progress") {
        reason = `reattach limit (${MAX_REATTACH_PER_STEP}) reached while assistant message still in-progress`;
      } else {
        reason = `reattach limit (${MAX_REATTACH_PER_STEP}) reached after assistant message completed server-side`;
      }
      return { kind: "leave-session-alone", reason };
    }
    let why: string;
    if (evaluation.pending) {
      why = "session still busy on opencode side";
    } else if (evaluation.classification.kind === "done") {
      why = "assistant message completed server-side despite client error";
    } else {
      why = "assistant message still in-progress";
    }
    return { kind: "reattach", why };
  }
  if (evaluation.classification.kind === "failed" || evaluation.classification.kind === "empty") {
    return { kind: "classify-failure", errorMessage: evaluation.classification.errorMessage };
  }
  return { kind: "retry-fresh" };
}

export function decideAfterPriorHealth(
  _attempt: Readonly<StepAttemptState>,
  input: PriorHealthInput,
): PriorHealthDecision {
  if (input.health === "stopped") return { kind: "interrupted-health-wait" };
  if (input.health === "unknown") return { kind: "leave-session-alone" };
  if (input.health === "pending" && !input.stopConfirmed) return { kind: "fail-closed" };
  return { kind: "retry-fresh" };
}
