import { describe, expect, test } from "bun:test";

import { BackoffAbortedError, backoffDelayMs, retryWithBackoff, type BackoffPolicy } from "../src/core/backoff.ts";

describe("backoffDelayMs", () => {
  test("returns exponential delays capped like failureRetryDelayMs", () => {
    // Given: the orchestrator failure retry policy.
    const policy: BackoffPolicy = { baseMs: 2_000, maxDelayMs: 30_000 };

    // When: delays are computed for consecutive zero-based attempts.
    const delays = [0, 1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(policy, attempt));

    // Then: the delay doubles from 2s and caps at 30s.
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  test("clamps delays to the remaining total budget like server recovery", () => {
    // Given: the runner server recovery policy with a smaller remaining budget.
    const policy: BackoffPolicy = { baseMs: 2_000, maxDelayMs: 30_000 };

    // When: the exponential delay exceeds the remaining budget.
    const clamped = backoffDelayMs(policy, 3, 1_500);
    const minimumPositive = backoffDelayMs(policy, 3, -25);

    // Then: delay is clamped to the remaining budget, with a one millisecond minimum.
    expect(clamped).toBe(1_500);
    expect(minimumPositive).toBe(1);
  });

  test("supports fixed-interval polling with multiplier one", () => {
    // Given: a fixed polling policy.
    const policy: BackoffPolicy = { baseMs: 250, multiplier: 1, maxTotalMs: 1_000 };

    // When: delays are computed across several attempts.
    const delays = [0, 1, 2, 3].map((attempt) => backoffDelayMs(policy, attempt));

    // Then: every retry uses the fixed interval.
    expect(delays).toEqual([250, 250, 250, 250]);
  });
});

describe("retryWithBackoff", () => {
  test("rethrows the last error when maxAttempts is exhausted", async () => {
    // Given: a retrying operation that always fails with a fresh error.
    const errors = [new Error("first"), new Error("second"), new Error("third")];
    const attempts: number[] = [];

    // When: retry budget allows three total attempts.
    const run = retryWithBackoff(
      async (attempt) => {
        attempts.push(attempt);
        const error = errors[attempt];
        if (error === undefined) throw new Error("unexpected attempt");
        throw error;
      },
      { baseMs: 10, maxAttempts: 3 },
      { sleep: async () => undefined },
    );

    // Then: the final observed error is rethrown after attempts 0, 1, and 2.
    const caught = await run.catch((error: unknown) => error);
    expect(caught).toBe(errors[2]);
    expect(attempts).toEqual([0, 1, 2]);
  });

  test("aborts promptly while waiting between attempts", async () => {
    // Given: a retry whose injected sleep never resolves by itself.
    const controller = new AbortController();
    const reason = new Error("stop now");
    const sleepDurations: number[] = [];
    let attempts = 0;

    const run = retryWithBackoff(
      async () => {
        attempts += 1;
        throw new Error("retryable");
      },
      { baseMs: 1_000, maxAttempts: 5 },
      {
        signal: controller.signal,
        sleep: async (ms) => {
          sleepDurations.push(ms);
          return await new Promise<void>(() => undefined);
        },
      },
    );

    // When: the signal aborts during the first backoff sleep.
    await Promise.resolve();
    controller.abort(reason);

    // Then: the abort reason is rethrown without another attempt.
    const caught = await run.catch((error: unknown) => error);
    expect(caught).toBe(reason);
    expect(attempts).toBe(1);
    expect(sleepDurations).toEqual([1_000]);
  });

  test("stops between attempts when shouldStop becomes true", async () => {
    // Given: a stop predicate that becomes true after the first failed attempt.
    let attempts = 0;
    const sleeps: number[] = [];

    const run = retryWithBackoff(
      async () => {
        attempts += 1;
        throw new Error("retryable");
      },
      { baseMs: 100, maxAttempts: 3 },
      {
        shouldStop: () => attempts > 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    // When/Then: cancellation is reported before sleeping or retrying.
    const caught = await run.catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(BackoffAbortedError);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("returns the value from the first successful retry and stops", async () => {
    // Given: an operation that succeeds on its third invocation.
    const attempts: number[] = [];

    // When: retrying with enough budget to reach the success.
    const value = await retryWithBackoff(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 2) throw new Error(`fail ${attempt}`);
        return "ready";
      },
      { baseMs: 5, maxAttempts: 5 },
      { sleep: async () => undefined },
    );

    // Then: the success value is returned and no fourth call is made.
    expect(value).toBe("ready");
    expect(attempts).toEqual([0, 1, 2]);
  });

  test("does not retry errors rejected by isRetryable", async () => {
    // Given: a classifier that rejects the first thrown error.
    const terminal = new Error("terminal");
    let attempts = 0;

    const run = retryWithBackoff(
      async () => {
        attempts += 1;
        throw terminal;
      },
      { baseMs: 5, maxAttempts: 5 },
      { isRetryable: () => false, sleep: async () => undefined },
    );

    // When/Then: the original error is rethrown without sleeping or retrying.
    const caught = await run.catch((error: unknown) => error);
    expect(caught).toBe(terminal);
    expect(attempts).toBe(1);
  });
});
