import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, test } from "bun:test";

import { loopStateRunStepContext } from "../src/lib/loop-state-reporter.ts";
import { clearContinuationStatus, setContinuationStatus, waitForLoopContinuationIdle } from "../src/opencode/background-tasks.ts";
import type { RunContinuationRecord } from "../src/opencode/continuation-records.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";

const SESSION_ID = "ses_continuation_indicator";
const UPDATED_AT = "2026-07-27T12:34:56.000Z";

function state(): LoopState {
  return createLoopState({ maxIterations: 1, stepNames: ["Build"] });
}

function record(reason?: string): RunContinuationRecord {
  return {
    sessionID: SESSION_ID,
    updatedAt: UPDATED_AT,
    source: {
      state: "active",
      updatedAt: UPDATED_AT,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

function client(): OpencodeClient {
  return {
    session: {
      children: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
    },
  } as unknown as OpencodeClient;
}

describe("continuation indicator", () => {
  test("sets the active continuation reason and start time", () => {
    // Given
    const loopState = state();

    // When
    setContinuationStatus(loopStateRunStepContext(loopState, loopState.control), 0, record("waiting for delegated work"));

    // Then
    expect(loopState.steps[0]?.continuation).toEqual({
      reason: "waiting for delegated work",
      since: Date.parse(UPDATED_AT),
    });
  });

  test("clears the continuation indicator", () => {
    // Given
    const loopState = state();
    const ctx = loopStateRunStepContext(loopState, loopState.control);
    setContinuationStatus(ctx, 0, record("waiting for delegated work"));

    // When
    clearContinuationStatus(ctx, 0);

    // Then
    expect(loopState.steps[0]?.continuation).toBeUndefined();
  });

  test("sets continuation without background agent entries", () => {
    // Given
    const loopState = state();
    expect(loopState.steps[0]?.backgroundAgents).toEqual([]);

    // When
    setContinuationStatus(loopStateRunStepContext(loopState, loopState.control), 0, record());

    // Then
    expect(loopState.steps[0]?.continuation?.reason).toBe("background tasks active");
  });

  test("clears continuation when the wait exits through restart", async () => {
    // Given
    const loopState = state();
    const ctx = loopStateRunStepContext(loopState, loopState.control);
    setContinuationStatus(ctx, 0, record("waiting for delegated work"));
    loopState.restartRequested = true;

    // When
    const result = await waitForLoopContinuationIdle({
      ctx,
      client: client(),
      stepIndex: 0,
      repoDir: "/tmp",
      sessionID: SESSION_ID,
    });

    // Then
    expect(result).toBe("restart");
    expect(loopState.steps[0]?.continuation).toBeUndefined();
  });
});
