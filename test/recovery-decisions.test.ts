import { describe, expect, test } from "bun:test";

import { recoveryResumeForChoice, shouldAutoStartSavedSession } from "../src/lib/recovery-decisions.ts";
import type { RunState } from "../src/lib/state-files.ts";

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    iteration: 1,
    stepIndex: 0,
    stepName: "Build",
    sessionID: "ses_failed",
    messageID: "msg_failed",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("recoveryResumeForChoice", () => {
  test("restart carries the failed session for reconciliation while quit discards it", () => {
    // Given a failed session, when restart is chosen, then reconcile it before starting fresh.
    expect(recoveryResumeForChoice({ choice: "restart", failedSessionID: "ses_failed", failedStepName: "Build", runState: runState() })).toMatchObject({ sessionID: "ses_failed", stepName: "Build" });
    expect(recoveryResumeForChoice({ choice: "quit", failedSessionID: "ses_failed", failedStepName: "Build", runState: runState() })).toBeUndefined();

    expect(recoveryResumeForChoice({ choice: "nudge", failedSessionID: "ses_failed", failedStepName: "Build", runState: runState() })).toEqual({
      sessionID: "ses_failed",
      messageID: "msg_failed",
      stepName: "Build",
    });
  });

  test("restart retains a failed session even when its checkpoint is unavailable", () => {
    // Given no checkpoint, when restart is chosen, then the session still requires confirm-stop.
    expect(recoveryResumeForChoice({ choice: "restart", failedSessionID: "ses_failed", failedStepName: "Build", runState: null })).toEqual({ sessionID: "ses_failed", stepName: "Build" });
  });

  test("nudge copies the persisted prompt and Looper-owned message IDs", () => {
    // Given
    const looperMessageIDs = ["msg_initial"];
    const state = runState({ promptText: "exact persisted prompt", looperMessageIDs });

    // When
    const decision = recoveryResumeForChoice({ choice: "nudge", failedSessionID: "ses_failed", failedStepName: "Build", runState: state });
    looperMessageIDs.push("msg_later");

    // Then
    expect(decision).toEqual({
      sessionID: "ses_failed",
      messageID: "msg_failed",
      stepName: "Build",
      promptText: "exact persisted prompt",
      looperMessageIDs: ["msg_initial"],
    });
  });

  test("nudge discards stale checkpoint metadata but retains the session requiring reconciliation", () => {
    expect(recoveryResumeForChoice({ choice: "nudge", failedSessionID: "ses_failed", failedStepName: "Build", runState: runState({ sessionID: "ses_other" }) })).toEqual({ sessionID: "ses_failed", stepName: "Build" });
    expect(recoveryResumeForChoice({ choice: "nudge", failedSessionID: "ses_failed", failedStepName: "Build", runState: runState({ messageID: undefined }) })).toEqual({ sessionID: "ses_failed", stepName: "Build" });
  });
});

describe("shouldAutoStartSavedSession", () => {
  test("does not auto-start after a prior stop request", () => {
    expect(shouldAutoStartSavedSession({ started: false, fresh: false, stopFilePresent: true, stopAfterIterationFilePresent: false })).toBe(false);
    expect(shouldAutoStartSavedSession({ started: false, fresh: false, stopFilePresent: false, stopAfterIterationFilePresent: true })).toBe(false);
  });

  test("auto-starts only for an untouched resumable launch", () => {
    expect(shouldAutoStartSavedSession({ started: false, fresh: false, stopFilePresent: false, stopAfterIterationFilePresent: false })).toBe(true);
    expect(shouldAutoStartSavedSession({ started: true, fresh: false, stopFilePresent: false, stopAfterIterationFilePresent: false })).toBe(false);
    expect(shouldAutoStartSavedSession({ started: false, fresh: true, stopFilePresent: false, stopAfterIterationFilePresent: false })).toBe(false);
  });
});
