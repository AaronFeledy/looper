import { randomUUID } from "node:crypto";

export type LooperSessionPurpose = "step" | "title";

export type LooperSessionMetadataInput = {
  looperRunID: string;
  iteration: number;
  stepIndex: number;
  stepName: string;
  configDir: string;
  repoDir: string;
  purpose: LooperSessionPurpose;
  parentSessionID?: string;
};

export type LooperSessionMetadata = {
  looper: true;
  looperRunID: string;
  iteration: number;
  stepIndex: number;
  stepName: string;
  configDir: string;
  repoDir: string;
  purpose: LooperSessionPurpose;
  parentSessionID?: string;
};

export function createLooperRunID(): string {
  return `looper-${randomUUID()}`;
}

export function buildLooperSessionMetadata(input: LooperSessionMetadataInput): LooperSessionMetadata {
  return {
    looper: true,
    looperRunID: input.looperRunID,
    iteration: input.iteration,
    stepIndex: input.stepIndex,
    stepName: input.stepName,
    configDir: input.configDir,
    repoDir: input.repoDir,
    purpose: input.purpose,
    ...(input.parentSessionID !== undefined ? { parentSessionID: input.parentSessionID } : {}),
  };
}
