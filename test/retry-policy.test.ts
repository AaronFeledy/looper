import { describe, expect, test } from "bun:test";

import {
  MAX_BACKGROUND_RESUMES_PER_STEP,
  MAX_ORPHANED_BACKGROUND_NUDGES_PER_STEP,
  MAX_REATTACH_PER_STEP,
  applyFailureRetryJitter,
  failureRetryDelayMs,
  nextActionForBackgroundResume,
  nextActionForFailure,
  nextActionForOrphanedBackgroundNudge,
  shouldEvaluatePriorSessionForReattach,
} from "../src/core/retry-policy.ts";

const HOUR_MS = 3_600_000;

describe("retry-policy", () => {
  test("failureRetryDelayMs uses a minutes-scale capped exponential schedule", () => {
    expect(failureRetryDelayMs(1)).toBe(15_000);
    expect(failureRetryDelayMs(2)).toBe(30_000);
    expect(failureRetryDelayMs(3)).toBe(60_000);
    expect(failureRetryDelayMs(4)).toBe(120_000);
    expect(failureRetryDelayMs(5)).toBe(240_000);
    expect(failureRetryDelayMs(6)).toBe(300_000);
    expect(failureRetryDelayMs(10)).toBe(300_000);
  });

  test("nextActionForFailure retries while remaining step budget can still run an attempt", () => {
    const cases = [
      { name: "first failure", input: { failureRetryCount: 0, remainingBudgetMs: HOUR_MS, suppressFailureRetry: false, stopRequested: false }, expected: { kind: "retry" as const, attempt: 1, delayMs: 15_000 } },
      { name: "later failure still retries", input: { failureRetryCount: 8, remainingBudgetMs: HOUR_MS, suppressFailureRetry: false, stopRequested: false }, expected: { kind: "retry" as const, attempt: 9, delayMs: 300_000 } },
      { name: "clamps delay to leftover budget", input: { failureRetryCount: 0, remainingBudgetMs: 12_000, suppressFailureRetry: false, stopRequested: false }, expected: { kind: "retry" as const, attempt: 1, delayMs: 7_000 } },
      { name: "budget exhausted", input: { failureRetryCount: 0, remainingBudgetMs: 5_000, suppressFailureRetry: false, stopRequested: false }, expected: { kind: "fail" as const, reason: "retry budget exhausted" } },
      { name: "suppressed", input: { failureRetryCount: 0, remainingBudgetMs: HOUR_MS, suppressFailureRetry: true, suppressReason: "background-wait outcome", stopRequested: false }, expected: { kind: "fail" as const, reason: "retry suppressed (background-wait outcome)" } },
      { name: "suppressed default", input: { failureRetryCount: 0, remainingBudgetMs: HOUR_MS, suppressFailureRetry: true, stopRequested: false }, expected: { kind: "fail" as const, reason: "retry suppressed (background-wait outcome)" } },
      { name: "stop", input: { failureRetryCount: 0, remainingBudgetMs: HOUR_MS, suppressFailureRetry: false, stopRequested: true }, expected: { kind: "fail" as const, reason: "stop requested" } },
    ] as const;

    for (const item of cases) {
      expect(nextActionForFailure(item.input), item.name).toEqual(item.expected);
    }
  });

  test("applyFailureRetryJitter is a no-op at ratio 0 and scales delay by unit", () => {
    expect(applyFailureRetryJitter(15_000, 1, 0)).toBe(15_000);
    expect(applyFailureRetryJitter(15_000, 1, 0.2)).toBe(18_000);
    expect(applyFailureRetryJitter(15_000, -1, 0.2)).toBe(12_000);
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
