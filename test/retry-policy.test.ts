import { describe, expect, test } from "bun:test";

import {
  MAX_BACKGROUND_RESUMES_PER_STEP,
  MAX_FAILURE_RETRIES_PER_STEP,
  MAX_ORPHANED_BACKGROUND_NUDGES_PER_STEP,
  MAX_REATTACH_PER_STEP,
  failureRetryDelayMs,
  nextActionForBackgroundResume,
  nextActionForFailure,
  nextActionForOrphanedBackgroundNudge,
  shouldEvaluatePriorSessionForReattach,
} from "../src/core/retry-policy.ts";

describe("retry-policy", () => {
  test("failureRetryDelayMs keeps the existing capped exponential schedule", () => {
    expect(failureRetryDelayMs(1)).toBe(2_000);
    expect(failureRetryDelayMs(2)).toBe(4_000);
    expect(failureRetryDelayMs(10)).toBe(30_000);
  });

  test("nextActionForFailure retries until a budget or suppression stops it", () => {
    const cases = [
      { name: "first failure", input: { failureRetryCount: 0, suppressFailureRetry: false, stopRequested: false }, expected: { kind: "retry", attempt: 1, delayMs: 2_000 } },
      { name: "second failure", input: { failureRetryCount: 1, suppressFailureRetry: false, stopRequested: false }, expected: { kind: "retry", attempt: 2, delayMs: 4_000 } },
      { name: "retry limit", input: { failureRetryCount: MAX_FAILURE_RETRIES_PER_STEP, suppressFailureRetry: false, stopRequested: false }, expected: { kind: "fail", reason: `retry limit reached (${MAX_FAILURE_RETRIES_PER_STEP})` } },
      { name: "suppressed", input: { failureRetryCount: 0, suppressFailureRetry: true, suppressReason: "background-wait outcome", stopRequested: false }, expected: { kind: "fail", reason: "retry suppressed (background-wait outcome)" } },
      { name: "suppressed default", input: { failureRetryCount: 0, suppressFailureRetry: true, stopRequested: false }, expected: { kind: "fail", reason: "retry suppressed (background-wait outcome)" } },
      { name: "stop", input: { failureRetryCount: 0, suppressFailureRetry: false, stopRequested: true }, expected: { kind: "fail", reason: "stop requested" } },
    ] as const;

    for (const item of cases) {
      expect(nextActionForFailure(item.input), item.name).toEqual(item.expected);
    }
  });

  test("budget predicates preserve the current strictly-greater-than checks", () => {
    expect(nextActionForBackgroundResume(MAX_BACKGROUND_RESUMES_PER_STEP)).toEqual({ kind: "resume" });
    expect(nextActionForBackgroundResume(MAX_BACKGROUND_RESUMES_PER_STEP + 1)).toEqual({ kind: "fail", reason: `background task resume limit (${MAX_BACKGROUND_RESUMES_PER_STEP}) exceeded` });

    expect(nextActionForOrphanedBackgroundNudge(MAX_ORPHANED_BACKGROUND_NUDGES_PER_STEP)).toEqual({ kind: "nudge" });
    expect(nextActionForOrphanedBackgroundNudge(MAX_ORPHANED_BACKGROUND_NUDGES_PER_STEP + 1)).toEqual({ kind: "fail", reason: "background marker still orphaned after nudge" });
  });

  test("reattach evaluation is only attempted when all existing gates pass", () => {
    expect(shouldEvaluatePriorSessionForReattach({ sessionID: "ses", messageID: "msg", reattachCount: 0 })).toBe(true);
    expect(shouldEvaluatePriorSessionForReattach({ sessionID: undefined, messageID: "msg", reattachCount: 0 })).toBe(false);
    expect(shouldEvaluatePriorSessionForReattach({ sessionID: "ses", messageID: undefined, reattachCount: 0 })).toBe(false);
    expect(shouldEvaluatePriorSessionForReattach({ sessionID: "ses", messageID: "msg", reattachCount: MAX_REATTACH_PER_STEP })).toBe(false);
  });
});
