import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { decideResume } from "../core/resume-policy.ts";
import type { RunResumePlan } from "../engine/run-engine.ts";
import { resumeSessionWorkState } from "../opencode/reattach.ts";
import { applyResumableBootUi, setBootResumeSession, type LoopState } from "./state.ts";

/** Detection is read-only; a confirmed attachable session automatically resumes through the engine. */
export async function checkSavedSessionOnStartup({
  state, plan, client, repoDir, fresh, signal, timeoutMs, staleBusyThresholdMs,
}: {
  state: LoopState; plan: RunResumePlan; client: OpencodeClient; repoDir: string; fresh: boolean;
  signal?: AbortSignal; timeoutMs: number; staleBusyThresholdMs?: number;
}): Promise<boolean> {
  const resume = plan.firstIterationResume;
  if (fresh || state.started || state.control.quitting || state.control.stopAfterIteration || !plan.resumed || !resume?.sessionID || signal?.aborted) return false;
  applyResumableBootUi(state, {
    resumed: true, startIteration: plan.startIteration, startStepIndex: plan.firstIterationStartStepIndex,
    resume, title: plan.firstIterationTitle, stepSessions: plan.firstIterationStepSessions,
  });
  const stepIndex = plan.firstIterationStartStepIndex;
  const owner = state.steps[stepIndex];
  if (!owner) return false;
  const sessionID = resume.sessionID;
  const current = () => !signal?.aborted && !state.started && !state.control.quitting && !state.control.stopAfterIteration && state.steps[stepIndex] === owner && owner.sessionID === sessionID;
  setBootResumeSession(state, { stepIndex, sessionID, workState: "checking", canReattach: false });
  let workState: Awaited<ReturnType<typeof resumeSessionWorkState>>;
  try {
    workState = await resumeSessionWorkState({ client, repoDir, sessionID, statusTimeoutMs: timeoutMs, staleBusyThresholdMs, signal });
  } catch {
    workState = "unknown";
  }
  if (!current()) return false;
  const canReattach = decideResume({
    currentStepName: owner.name, recordedStepName: resume.stepName, messageID: resume.messageID,
    workState, recoveryNudgeActive: false,
  }).kind === "reattach";
  setBootResumeSession(state, { stepIndex, sessionID, workState, canReattach });
  return canReattach;
}

/** Inspecting or reselecting the checkpoint must not discard its in-flight session. */
export function resumePlanForSelection(plan: RunResumePlan, selectedStepIndex: number | null): RunResumePlan {
  if (selectedStepIndex === null || selectedStepIndex === plan.firstIterationStartStepIndex) return plan;
  const resumed = plan.resumed && selectedStepIndex >= plan.firstIterationStartStepIndex;
  return {
    ...plan, firstIterationStartStepIndex: selectedStepIndex, firstIterationResume: undefined, resumed,
    firstIterationTitle: resumed ? plan.firstIterationTitle : undefined,
    firstIterationStepSessions: resumed ? plan.firstIterationStepSessions : undefined,
  };
}
