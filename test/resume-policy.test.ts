import { describe, expect, test } from "bun:test";

import { decideResume } from "../src/core/resume-policy.ts";

describe("decideResume", () => {
  test("reattaches only when the recorded step still matches, work is running, and messageID exists", () => {
    expect(decideResume({ currentStepName: "Build", recordedStepName: "Build", workState: "running", messageID: "msg_1", recoveryNudgeActive: false })).toEqual({ kind: "reattach" });
    expect(decideResume({ currentStepName: "Build", recordedStepName: undefined, workState: "running", messageID: "msg_1", recoveryNudgeActive: false })).toEqual({ kind: "reattach" });
  });

  test("idle sessions either restart fresh or nudge the existing session during recovery", () => {
    expect(decideResume({ currentStepName: "Build", recordedStepName: "Build", workState: "idle", messageID: "msg_1", recoveryNudgeActive: false })).toEqual({ kind: "restart-fresh" });
    expect(decideResume({ currentStepName: "Build", recordedStepName: "Build", workState: "idle", messageID: "msg_1", recoveryNudgeActive: true })).toEqual({ kind: "nudge-existing" });
    expect(decideResume({ currentStepName: "Build", recordedStepName: "Build", workState: "idle", messageID: undefined, recoveryNudgeActive: true })).toEqual({ kind: "restart-fresh" });
  });

  test("unknown matching sessions fail closed as unrecovered server instead of restarting", () => {
    expect(decideResume({ currentStepName: "Build", recordedStepName: "Build", workState: "unknown", messageID: "msg_1", recoveryNudgeActive: false })).toEqual({
      kind: "fail-closed",
      cause: "unrecovered-server",
      reason: "prior session work state is unknown",
    });
  });

  test("fail-closed cases preserve the existing reasons", () => {
    const cases = [
      { name: "step mismatch", input: { currentStepName: "Test", recordedStepName: "Build", workState: "idle", messageID: "msg_1", recoveryNudgeActive: false }, cause: "step-mismatch", reason: "step changed since the session was recorded" },
      { name: "running without message", input: { currentStepName: "Build", recordedStepName: "Build", workState: "running", messageID: undefined, recoveryNudgeActive: false }, cause: "running-without-message-id", reason: "prior session is running but no messageID was recorded" },
    ] as const;

    for (const item of cases) {
      expect(decideResume(item.input), item.name).toEqual({ kind: "fail-closed", cause: item.cause, reason: item.reason });
    }
  });
});
