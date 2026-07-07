export function textEndsWithNewline(text: string): boolean {
  return text.endsWith("\n");
}

export function backgroundContinuationPrompt(): string {
  return "Background agents are done. Check their results, incorporate what you learned, and continue this step until it is complete. If more background tasks are needed, wait for them before reporting completion.\n";
}

export function orphanedBackgroundNudgePrompt(): string {
  return "Your background task is no longer running but never reported completion. Verify its result directly in the foreground — do NOT start another background task. If the work finished successfully, complete this step. If it failed or cannot be verified, stop and report the failure clearly.\n";
}

export function failureRetryPrompt(prompt: string, failedSessionID: string | undefined): string {
  const sessionLine = failedSessionID === undefined
    ? "The failed session id was not recorded."
    : `The failed session id was ${failedSessionID}. tail or inspect that session for context on where the previous attempt left off.`;
  return `Note: This is a retry in a new session because the previous attempt failed. ${sessionLine} Inspect the existing workspace/state and continue from any useful work rather than blindly starting over.\n\n${prompt}`;
}

export function cleanRestartPrompt(prompt: string, reason: "timeout" | "manual"): string {
  const label = reason === "timeout" ? "timed out" : "was manually restarted";
  return `Note: This is a clean restart in a new session because the previous attempt ${label}. The previous attempt may have been interrupted after making partial progress, so inspect the existing workspace/state and continue from any useful work rather than blindly starting over.\n\n${prompt}`;
}

export function recoveryNudgePrompt(prompt: string): string {
  return `Continue working to completion if you haven't already. If the work is already complete, report the result.\n\n${prompt}`;
}
