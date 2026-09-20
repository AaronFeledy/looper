import {
  clearStepAttempt,
  clearStepAttempts,
  readStepAttempt,
  readStoryStepAttempts,
  recordStepNonAdvance,
} from "../lib/step-attempt-files.ts";
import { initStatePaths } from "../lib/state-files.ts";

export type StepAttemptStore = {
  readonly read: typeof readStepAttempt;
  readonly readStory: typeof readStoryStepAttempts;
  readonly recordNonAdvance: typeof recordStepNonAdvance;
  readonly clearStep: typeof clearStepAttempt;
  readonly clear: typeof clearStepAttempts;
};

export function createStepAttemptStore(opts: { readonly configDir: string }): StepAttemptStore {
  initStatePaths({ configDir: opts.configDir });
  return {
    read: readStepAttempt,
    readStory: readStoryStepAttempts,
    recordNonAdvance: recordStepNonAdvance,
    clearStep: clearStepAttempt,
    clear: clearStepAttempts,
  };
}
