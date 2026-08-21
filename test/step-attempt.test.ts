import { describe, expect, test } from "bun:test";

import {
  createStepAttemptState,
  decideAfterFailurePolicy,
  decideAfterPriorEvaluation,
  decideAfterPriorHealth,
} from "../src/core/step-attempt.ts";
import { MAX_REATTACH_PER_STEP } from "../src/core/retry-policy.ts";

describe("step-attempt staged decisions", () => {
  test("decideAfterFailurePolicy fails when retries are suppressed or exhausted", () => {
    const cases = [
      {
        name: "suppressed",
        configure: () => ({ ...createStepAttemptState(), suppressFailureRetry: true, suppressReason: "unsafe retry" }),
        remainingBudgetMs: 3_600_000,
        expected: { kind: "fail", reason: "retry suppressed (unsafe retry)" },
      },
      {
        name: "budget exhausted",
        configure: () => createStepAttemptState(),
        remainingBudgetMs: 0,
        expected: { kind: "fail", reason: "retry budget exhausted" },
      },
    ] as const;

    for (const item of cases) {
      const attempt = item.configure();

      const decision = decideAfterFailurePolicy(attempt, {
        stopRequested: false,
        remainingBudgetMs: item.remainingBudgetMs,
      });

      expect(decision, item.name).toEqual(item.expected);
    }
  });

  test("decideAfterPriorEvaluation reattaches a live prior session while under the cap", () => {
    const attempt = { ...createStepAttemptState(), reattachCount: MAX_REATTACH_PER_STEP - 1 };
    const evaluation = {
      statusKnown: true,
      pending: true,
      classification: { kind: "missing" as const },
    };

    const decision = decideAfterPriorEvaluation(attempt, {
      evaluation,
      reattachAllowed: { sessionID: "ses_live", messageID: "msg_live" },
    });

    expect(decision).toEqual({ kind: "reattach", why: "session still busy on opencode side" });
  });

  test("decideAfterPriorEvaluation stages classification failures before a fresh retry", () => {
    const attempt = createStepAttemptState();
    const evaluation = {
      statusKnown: true,
      pending: false,
      classification: { kind: "failed" as const, errorMessage: "provider failed" },
    };

    const decision = decideAfterPriorEvaluation(attempt, {
      evaluation,
      reattachAllowed: { sessionID: "ses_failed", messageID: "msg_failed" },
    });

    expect(decision).toEqual({ kind: "classify-failure", errorMessage: "provider failed" });
  });

  test("decideAfterPriorHealth fails closed when an active session could not be stopped", () => {
    const attempt = createStepAttemptState();

    const decision = decideAfterPriorHealth(attempt, { health: "pending", stopConfirmed: false });

    expect(decision).toEqual({ kind: "fail-closed" });
  });

  test("decideAfterPriorHealth retries fresh after an idle or confirmed-stopped prior session", () => {
    const cases = [
      { name: "idle", health: "idle" },
      { name: "confirmed stop", health: "pending", stopConfirmed: true },
    ] as const;

    for (const item of cases) {
      const attempt = createStepAttemptState();

      const decision = decideAfterPriorHealth(attempt, item);

      expect(decision, item.name).toEqual({ kind: "retry-fresh" });
    }
  });
});
