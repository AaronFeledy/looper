import type { RecoveryChoice } from "./state.ts";
import type { RunState } from "./state-files.ts";

export type RecoveryResumeDecision = {
  readonly sessionID: string;
  readonly messageID: string;
  readonly stepName?: string;
  readonly promptText?: string;
  readonly looperMessageIDs?: string[];
};

export function recoveryResumeForChoice({
  choice,
  failedSessionID,
  failedStepName,
  runState,
}: {
  choice: RecoveryChoice;
  failedSessionID: string | undefined;
  failedStepName: string | undefined;
  runState: RunState | null;
}): RecoveryResumeDecision | undefined {
  if (choice !== "nudge") return undefined;
  if (failedSessionID === undefined) return undefined;
  if (runState?.sessionID !== failedSessionID || runState.messageID === undefined) return undefined;
  return {
    sessionID: failedSessionID,
    messageID: runState.messageID,
    ...(failedStepName !== undefined ? { stepName: failedStepName } : {}),
    ...(runState.promptText !== undefined ? { promptText: runState.promptText } : {}),
    ...(runState.looperMessageIDs !== undefined ? { looperMessageIDs: [...runState.looperMessageIDs] } : {}),
  };
}

export function shouldAutoStartSavedSession({
  started,
  fresh,
  stopFilePresent,
  stopAfterIterationFilePresent,
}: {
  started: boolean;
  fresh: boolean;
  stopFilePresent: boolean;
  stopAfterIterationFilePresent: boolean;
}): boolean {
  return !started && !fresh && !stopFilePresent && !stopAfterIterationFilePresent;
}
