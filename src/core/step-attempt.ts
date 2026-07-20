export type StepAttemptState = {
  suppressFailureRetry: boolean;
  suppressReason: string | undefined;
  allowTerminalSessionToContinue: boolean;
  failureRetryCount: number;
  reattachCount: number;
  backgroundResumeCount: number;
  orphanNudgeCount: number;
  recoveryNudgeActive: boolean;
  resumeSessionID: string | undefined;
  resumePrompt: string | undefined;
  lastErrorMessage: string | undefined;
  lastPromptMessageID: string | undefined;
};

export function createStepAttemptState(): StepAttemptState {
  return {
    suppressFailureRetry: false,
    suppressReason: undefined,
    allowTerminalSessionToContinue: false,
    failureRetryCount: 0,
    reattachCount: 0,
    backgroundResumeCount: 0,
    orphanNudgeCount: 0,
    recoveryNudgeActive: false,
    resumeSessionID: undefined,
    resumePrompt: undefined,
    lastErrorMessage: undefined,
    lastPromptMessageID: undefined,
  };
}
