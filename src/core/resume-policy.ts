export type ResumeWorkState = "running" | "idle" | "unknown";

export type ResumeDecision =
  | { readonly kind: "reattach" }
  | { readonly kind: "restart-fresh" }
  | { readonly kind: "nudge-existing" }
  | { readonly kind: "fail-closed"; readonly cause: "unrecovered-server" | "step-mismatch" | "running-without-message-id" | "unknown-state"; readonly reason: string };

export type ResumeDecisionInput = {
  readonly currentStepName: string;
  readonly recordedStepName: string | undefined;
  readonly workState: ResumeWorkState;
  readonly messageID: string | undefined;
  readonly recoveryNudgeActive: boolean;
};

export function decideResume(input: ResumeDecisionInput): ResumeDecision {
  const stepMatches = input.recordedStepName === undefined || input.recordedStepName === input.currentStepName;
  if (stepMatches && input.workState === "running" && input.messageID !== undefined) return { kind: "reattach" };
  if (stepMatches && input.workState === "idle") {
    if (input.recoveryNudgeActive && input.messageID !== undefined) return { kind: "nudge-existing" };
    return { kind: "restart-fresh" };
  }
  if (stepMatches && input.workState === "unknown") return { kind: "fail-closed", cause: "unrecovered-server", reason: "prior session work state is unknown" };
  if (!stepMatches) return { kind: "fail-closed", cause: "step-mismatch", reason: "step changed since the session was recorded" };
  if (input.workState === "running") return { kind: "fail-closed", cause: "running-without-message-id", reason: "prior session is running but no messageID was recorded" };
  return { kind: "fail-closed", cause: "unknown-state", reason: `prior session is ${input.workState}` };
}
