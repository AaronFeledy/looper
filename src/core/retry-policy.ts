export const MAX_BACKGROUND_RESUMES_PER_STEP = 10;
export const MAX_FAILURE_RETRIES_PER_STEP = 2;
export const MAX_REATTACH_PER_STEP = 5;
export const MAX_ORPHANED_BACKGROUND_NUDGES_PER_STEP = 1;

const FAILURE_RETRY_BASE_DELAY_MS = 2_000;
const FAILURE_RETRY_MAX_DELAY_MS = 30_000;

export type FailureRetryDecision =
  | { readonly kind: "retry"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "fail"; readonly reason: string };

export type FailureRetryInput = {
  readonly failureRetryCount: number;
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
  const exp = FAILURE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(exp, FAILURE_RETRY_MAX_DELAY_MS);
}

export function nextActionForFailure(input: FailureRetryInput): FailureRetryDecision {
  if (input.suppressFailureRetry) return { kind: "fail", reason: `retry suppressed (${input.suppressReason ?? "background-wait outcome"})` };
  if (input.failureRetryCount >= MAX_FAILURE_RETRIES_PER_STEP) return { kind: "fail", reason: `retry limit reached (${MAX_FAILURE_RETRIES_PER_STEP})` };
  if (input.stopRequested) return { kind: "fail", reason: "stop requested" };
  const attempt = input.failureRetryCount + 1;
  return { kind: "retry", attempt, delayMs: failureRetryDelayMs(attempt) };
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
