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
  test("only nudge reuses the failed session", () => {
    expect(recoveryResumeForChoice({ choice: "restart", failedSessionID: "ses_failed", failedStepName: "Build", runState: runState() })).toBeUndefined();
    expect(recoveryResumeForChoice({ choice: "quit", failedSessionID: "ses_failed", failedStepName: "Build", runState: runState() })).toBeUndefined();

    expect(recoveryResumeForChoice({ choice: "nudge", failedSessionID: "ses_failed", failedStepName: "Build", runState: runState() })).toEqual({
      sessionID: "ses_failed",
      messageID: "msg_failed",
      stepName: "Build",
    });
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

  test("nudge ignores stale or incomplete run state", () => {
    expect(recoveryResumeForChoice({ choice: "nudge", failedSessionID: "ses_failed", failedStepName: "Build", runState: runState({ sessionID: "ses_other" }) })).toBeUndefined();
    expect(recoveryResumeForChoice({ choice: "nudge", failedSessionID: "ses_failed", failedStepName: "Build", runState: runState({ messageID: undefined }) })).toBeUndefined();
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
