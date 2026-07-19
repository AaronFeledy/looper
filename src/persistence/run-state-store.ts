import {
  clearResumeStepFile,
  clearRunStateFile,
  clearStopAfterIterationFile,
  clearStopFile,
  initStatePaths,
  readRunState,
  readStopAfterIterationFile,
  readStopFile,
  stopAfterIterationFileExists,
  stopFileExists,
  writeResumeStep,
  writeRunState,
  writeStopAfterIterationFile,
  writeStopFile,
  type RunState,
  type StepSessionEntry,
} from "../lib/state-files.ts";

export type { RunState, StepSessionEntry } from "../lib/state-files.ts";

export type RunStateStoreStep = {
  readonly name: string;
};

export type RunStatePositionInput = {
  readonly iteration: number;
  readonly steps: readonly RunStateStoreStep[];
  readonly stepIndex: number;
  readonly stepName?: string;
  readonly sessionID?: string;
  readonly messageID?: string;
  readonly promptText?: string;
  readonly looperMessageIDs?: readonly string[];
  readonly title?: string;
  readonly looperRunID?: string;
  readonly stepSessions?: StepSessionEntry[];
};

export type RunStateAdvanceInput = {
  readonly iteration: number;
  readonly steps: readonly RunStateStoreStep[];
  readonly nextIndex: number;
  readonly title?: string;
  readonly looperRunID?: string;
  readonly stepSessions?: StepSessionEntry[];
};

export type RunStateStore = {
  readonly read: () => RunState | null;
  readonly saveResumeStep: (steps: readonly RunStateStoreStep[], stepIndex: number) => void;
  readonly saveNextResumeStep: (steps: readonly RunStateStoreStep[], nextIndex: number) => void;
  readonly savePosition: (input: RunStatePositionInput) => void;
  readonly saveAdvance: (input: RunStateAdvanceInput) => void;
  readonly clearForFreshRun: () => void;
  readonly clearRunArtifacts: () => void;
  readonly clearStopFiles: () => void;
  readonly stopReason: () => string;
  readonly stopFileExists: () => boolean;
  readonly stopAfterIterationFileExists: () => boolean;
  readonly writeStop: (reason: string) => void;
  readonly writeStopAfterIteration: (reason: string) => void;
};

function saveResumeStep(steps: readonly RunStateStoreStep[], stepIndex: number): void {
  const step = steps[stepIndex];
  if (step === undefined) {
    clearResumeStepFile();
    return;
  }
  writeResumeStep(stepIndex, step.name);
}

function saveNextResumeStep(steps: readonly RunStateStoreStep[], nextIndex: number): void {
  if (nextIndex >= steps.length) {
    clearResumeStepFile();
    return;
  }
  saveResumeStep(steps, nextIndex);
}

function savePosition(input: RunStatePositionInput): void {
  const step = input.steps[input.stepIndex];
  const stepName = input.stepName ?? step?.name;
  if (stepName === undefined) return;
  writeRunState({
    iteration: input.iteration,
    stepIndex: input.stepIndex,
    stepName,
    ...(input.sessionID !== undefined ? { sessionID: input.sessionID } : {}),
    ...(input.messageID !== undefined ? { messageID: input.messageID } : {}),
    ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
    ...(input.looperMessageIDs !== undefined ? { looperMessageIDs: [...input.looperMessageIDs] } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.looperRunID !== undefined ? { looperRunID: input.looperRunID } : {}),
    ...(input.stepSessions !== undefined ? { stepSessions: [...input.stepSessions] } : {}),
  });
}

function saveAdvance(input: RunStateAdvanceInput): void {
  const { iteration, steps, nextIndex, title, looperRunID, stepSessions } = input;
  if (steps.length === 0) {
    clearRunStateFile();
    return;
  }
  const firstStep = steps[0];
  if (firstStep === undefined) {
    clearRunStateFile();
    return;
  }
  if (nextIndex >= steps.length) {
    // Crossing into a new iteration: neither the prior iteration's title nor
    // its step sessions carry over.
    writeRunState({ iteration: iteration + 1, stepIndex: 0, stepName: firstStep.name, ...(looperRunID !== undefined ? { looperRunID } : {}) });
    return;
  }
  const nextStep = steps[nextIndex];
  if (nextStep === undefined) return;
  writeRunState({
    iteration,
    stepIndex: nextIndex,
    stepName: nextStep.name,
    ...(title !== undefined ? { title } : {}),
    ...(looperRunID !== undefined ? { looperRunID } : {}),
    ...(stepSessions !== undefined ? { stepSessions: [...stepSessions] } : {}),
  });
}

function clearRunArtifacts(): void {
  clearResumeStepFile();
  clearRunStateFile();
}

function clearStopFiles(): void {
  clearStopFile();
  clearStopAfterIterationFile();
}

function stopReason(): string {
  return readStopFile() ?? readStopAfterIterationFile() ?? "stop requested";
}

export function createRunStateStore(opts: { readonly configDir: string }): RunStateStore {
  initStatePaths({ configDir: opts.configDir });
  return {
    read: readRunState,
    saveResumeStep,
    saveNextResumeStep,
    savePosition,
    saveAdvance,
    clearForFreshRun: clearRunArtifacts,
    clearRunArtifacts,
    clearStopFiles,
    stopReason,
    stopFileExists,
    stopAfterIterationFileExists,
    writeStop: writeStopFile,
    writeStopAfterIteration: writeStopAfterIterationFile,
  };
}
