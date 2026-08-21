import { failureRetryBaseMs, failureRetryMaxDelayMs, failureRetryMinRemainingMs } from "../config/tunables.ts";

export const MAX_BACKGROUND_RESUMES_PER_STEP = 10;
export const MAX_REATTACH_PER_STEP = 5;
export const MAX_ORPHANED_BACKGROUND_NUDGES_PER_STEP = 1;

export type FailureRetryDecision =
  | { readonly kind: "retry"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "fail"; readonly reason: string };

export type FailureRetryInput = {
  readonly failureRetryCount: number;
  readonly remainingBudgetMs: number;
  readonly suppressFailureRetry: boolean;
  readonly suppressReason?: string;
  readonly stopRequested: boolean;
};

export type BackgroundResumeDecision =
  | { readonly kind: "resume" }
  | { readonly kind: "fail"; readonly reason: string };

export type OrphanedBackgroundNudgeDecision =
  | { readonly kind: "nudge" }
  | { readonly kind: "fail"; readonly reason: string };

export function failureRetryDelayMs(attempt: number): number {
  const exp = failureRetryBaseMs() * 2 ** (attempt - 1);
  return Math.min(exp, failureRetryMaxDelayMs());
}

export function applyFailureRetryJitter(delayMs: number, unit: number, ratio: number): number {
  if (ratio <= 0) return delayMs;
  const bounded = Math.min(1, Math.max(-1, unit));
  return Math.max(0, Math.round(delayMs * (1 + bounded * ratio)));
}

export function nextActionForFailure(input: FailureRetryInput): FailureRetryDecision {
  if (input.suppressFailureRetry) return { kind: "fail", reason: `retry suppressed (${input.suppressReason ?? "background-wait outcome"})` };
  if (input.stopRequested) return { kind: "fail", reason: "stop requested" };
  const minRemainingMs = failureRetryMinRemainingMs();
  if (input.remainingBudgetMs <= minRemainingMs) return { kind: "fail", reason: "retry budget exhausted" };
  const attempt = input.failureRetryCount + 1;
  const scheduledMs = failureRetryDelayMs(attempt);
  const delayMs = Math.min(scheduledMs, Math.max(0, input.remainingBudgetMs - minRemainingMs));
  return { kind: "retry", attempt, delayMs };
}

export function nextActionForBackgroundResume(resumeCount: number): BackgroundResumeDecision {
  if (resumeCount > MAX_BACKGROUND_RESUMES_PER_STEP) return { kind: "fail", reason: `background task resume limit (${MAX_BACKGROUND_RESUMES_PER_STEP}) exceeded` };
  return { kind: "resume" };
}

export function nextActionForOrphanedBackgroundNudge(nudgeCount: number): OrphanedBackgroundNudgeDecision {
  if (nudgeCount > MAX_ORPHANED_BACKGROUND_NUDGES_PER_STEP) return { kind: "fail", reason: "background marker still orphaned after nudge" };
  return { kind: "nudge" };
}

export function shouldEvaluatePriorSessionForReattach({
  sessionID,
  messageID,
  reattachCount,
}: {
  readonly sessionID: string | undefined;
  readonly messageID: string | undefined;
  readonly reattachCount: number;
}): boolean {
  return sessionID !== undefined && messageID !== undefined && reattachCount < MAX_REATTACH_PER_STEP;
}
