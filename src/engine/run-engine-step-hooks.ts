import type { RunIterationHooks } from "../lib/orchestrator.ts";
import type { StepSessionEntry } from "../lib/state-files.ts";
import type { RunStateStore } from "./engine-ports.ts";

type StepLike = { readonly name: string };

type BuildStepHooksInput = {
  readonly store: RunStateStore;
  readonly loadSteps: () => readonly StepLike[];
  readonly looperRunID: string;
  readonly persistTitles: boolean;
  readonly getStepSessions: () => readonly StepSessionEntry[];
  readonly setStepSessions: (entries: StepSessionEntry[]) => void;
  readonly frontendHooks: RunIterationHooks;
};

function upsertStepSession(entries: readonly StepSessionEntry[], entry: StepSessionEntry): StepSessionEntry[] {
  const next = entries.filter((existing) => existing.stepIndex !== entry.stepIndex);
  next.push(entry);
  next.sort((left, right) => left.stepIndex - right.stepIndex);
  return next;
}

export function buildEngineStepHooks(input: BuildStepHooksInput): RunIterationHooks {
  return {
    onStepBegin: (info) => {
      const latestSteps = input.loadSteps();
      const stepSessions = input.getStepSessions();
      input.store.saveResumeStep(latestSteps, info.index);
      input.store.savePosition({
        iteration: info.iteration,
        steps: latestSteps,
        stepIndex: info.index,
        ...(input.persistTitles && info.title !== undefined ? { title: info.title } : {}),
        looperRunID: input.looperRunID,
        ...(stepSessions.length > 0 ? { stepSessions: [...stepSessions] } : {}),
      });
      input.frontendHooks.onStepBegin?.(info);
    },
    onStepSession: (info) => {
      const stepSessions = upsertStepSession(input.getStepSessions(), { stepIndex: info.index, stepName: info.stepName, sessionID: info.sessionID });
      input.setStepSessions(stepSessions);
      input.store.savePosition({
        iteration: info.iteration,
        steps: input.loadSteps(),
        stepIndex: info.index,
        stepName: info.stepName,
        sessionID: info.sessionID,
        messageID: info.messageID,
        ...(info.promptText !== undefined ? { promptText: info.promptText } : {}),
        ...(info.looperMessageIDs !== undefined ? { looperMessageIDs: [...info.looperMessageIDs] } : {}),
        ...(input.persistTitles && info.title !== undefined ? { title: info.title } : {}),
        looperRunID: input.looperRunID,
        stepSessions,
      });
      input.frontendHooks.onStepSession?.(info);
    },
    onAdjudicationRoute: ({ iteration }) => {
      const latestSteps = input.loadSteps();
      input.store.saveNextResumeStep(latestSteps, latestSteps.length);
      input.store.saveAdvance({
        iteration,
        steps: latestSteps,
        nextIndex: latestSteps.length,
        looperRunID: input.looperRunID,
      });
    },
    onStepFinish: (info) => {
      const stepSessions = input.getStepSessions();
      if (info.completionKind === "done" || info.completionKind === "gate-skip") {
        const latestSteps = input.loadSteps();
        input.store.saveNextResumeStep(latestSteps, info.nextIndex);
        input.store.saveAdvance({
          iteration: info.iteration,
          steps: latestSteps,
          nextIndex: info.nextIndex,
          ...(input.persistTitles && info.title !== undefined ? { title: info.title } : {}),
          looperRunID: input.looperRunID,
          ...(stepSessions.length > 0 ? { stepSessions: [...stepSessions] } : {}),
        });
      }
      input.frontendHooks.onStepFinish?.(info);
    },
  };
}
