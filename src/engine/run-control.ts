import type { StepRestartReason } from "../core/step-view.ts";

export type TimeoutExtendResult = {
  readonly remainingMs: number;
};

export type TimeoutSnapshot = {
  readonly remainingMs: number;
  readonly originalMs: number;
};

export type RunControlView = {
  readonly quitting: boolean;
  readonly paused: boolean;
  readonly skipRequested: boolean;
  readonly restartRequested: boolean;
  readonly restartReason: StepRestartReason | undefined;
  readonly stopAfterIteration: boolean;
  readonly requestRestart: (reason: StepRestartReason) => void;
  readonly bindTimeoutExtender: (
    extend: (() => TimeoutExtendResult | undefined) | undefined,
    snapshot?: () => TimeoutSnapshot | undefined,
  ) => void;
  readonly extendTimeout: () => TimeoutExtendResult | undefined;
  readonly timeoutSnapshot: () => TimeoutSnapshot | undefined;
};

export type RunControl = RunControlView & {
  readonly setQuitting: (value: boolean) => void;
  readonly setPaused: (value: boolean) => void;
  readonly togglePaused: () => boolean;
  readonly requestSkip: () => void;
  readonly setStopAfterIteration: (value: boolean) => void;
  readonly setSkipRequested: (value: boolean) => void;
  readonly setRestartRequested: (value: boolean) => void;
  readonly setRestartReason: (reason: StepRestartReason | undefined) => void;
  readonly clearStepRequests: () => void;
  readonly clearRunRequests: () => void;
};

export function createRunControl(options?: { onChange?: () => void }): RunControl {
  const onChange = options?.onChange ?? (() => {});
  let quitting = false;
  let paused = false;
  let skipRequested = false;
  let restartRequested = false;
  let restartReason: StepRestartReason | undefined;
  let stopAfterIteration = false;
  let timeoutExtender: (() => TimeoutExtendResult | undefined) | undefined;
  let timeoutClock: (() => TimeoutSnapshot | undefined) | undefined;

  return {
    get quitting() {
      return quitting;
    },
    get paused() {
      return paused;
    },
    get skipRequested() {
      return skipRequested;
    },
    get restartRequested() {
      return restartRequested;
    },
    get restartReason() {
      return restartReason;
    },
    get stopAfterIteration() {
      return stopAfterIteration;
    },
    setQuitting(value: boolean) {
      quitting = value;
      onChange();
    },
    setPaused(value: boolean) {
      paused = value;
      onChange();
    },
    togglePaused() {
      paused = !paused;
      onChange();
      return paused;
    },
    requestSkip() {
      skipRequested = true;
      onChange();
    },
    requestRestart(reason: StepRestartReason) {
      restartRequested = true;
      restartReason = reason;
      onChange();
    },
    bindTimeoutExtender(extend, snapshot) {
      timeoutExtender = extend;
      timeoutClock = extend === undefined ? undefined : snapshot;
    },
    extendTimeout() {
      return timeoutExtender?.();
    },
    timeoutSnapshot() {
      return timeoutClock?.();
    },
    setStopAfterIteration(value: boolean) {
      stopAfterIteration = value;
      onChange();
    },
    setSkipRequested(value: boolean) {
      skipRequested = value;
      onChange();
    },
    setRestartRequested(value: boolean) {
      restartRequested = value;
      onChange();
    },
    setRestartReason(reason: StepRestartReason | undefined) {
      restartReason = reason;
      onChange();
    },
    clearStepRequests() {
      skipRequested = false;
      restartRequested = false;
      restartReason = undefined;
      onChange();
    },
    clearRunRequests() {
      quitting = false;
      stopAfterIteration = false;
      paused = false;
      onChange();
    },
  };
}
