export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";

export type LoopPane = "steps" | "output";

export type ScrollDirection = "up" | "down" | "pageup" | "pagedown" | "home" | "end";

export type ScrollIntent = { direction: ScrollDirection; stepIndex: number; seq: number };

export type LoopStep = {
  name: string;
  status: StepStatus;
  statusMessage?: string;
  startedAt?: number;
  finishedAt?: number;
  sessionID?: string;
  outputLines: string[];
  outputLineTimes: number[];
  outputScrollTop: number;
  outputPinnedToBottom: boolean;
};

/** Cap retained output lines; rendering very large scrollback can starve TUI input. */
export const AGENT_MAX_LINES = 5_000;
const NOTIFY_FRAME_MS = 33;

export type LoopState = {
  iteration: number;
  maxIterations: number;
  branch: string;
  iterationStartedAt: number;
  steps: LoopStep[];
  focusedPane: LoopPane;
  selectedStepIndex: number | null;
  manualStepSelection: boolean;
  activeStepIndex: number | null;
  started: boolean;
  paused: boolean;
  quitting: boolean;
  stopAfterIteration: boolean;
  skipRequested: boolean;
  restartRequested: boolean;
  agentLines: string[];
  agentLineTimes: number[];
  stepOutputLines: string[][];
  scrollIntent: ScrollIntent | null;
};

type Listener = () => void;

const listeners = new Set<Listener>();
let notifyTimer: ReturnType<typeof setTimeout> | undefined;

function createLoopStep(name: string): LoopStep {
  return {
    name,
    status: "pending",
    outputLines: [],
    outputLineTimes: [],
    outputScrollTop: 0,
    outputPinnedToBottom: true,
  };
}

function getStepCount(state: LoopState): number {
  return state.steps.length;
}

function clampStepIndex(stepCount: number, stepIndex: number | null): number | null {
  if (stepIndex === null || stepCount === 0) return null;
  return Math.max(0, Math.min(stepCount - 1, stepIndex));
}

function trimLines(lines: string[]): number {
  const overflow = lines.length - AGENT_MAX_LINES;
  if (overflow <= 0) return 0;
  lines.splice(0, overflow);
  return overflow;
}

function trimPairedLines(lines: string[], times: number[]): number {
  const overflow = lines.length - AGENT_MAX_LINES;
  if (overflow <= 0) return 0;
  lines.splice(0, overflow);
  times.splice(0, overflow);
  return overflow;
}

function getSelectedStep(state: LoopState): LoopStep | null {
  const selectedStepIndex = clampStepIndex(getStepCount(state), state.selectedStepIndex);
  if (selectedStepIndex === null) return null;
  return state.steps[selectedStepIndex] ?? null;
}

function notifyStateChange(): void {
  notify();
}

export function createLoopState({
  maxIterations,
  stepNames,
}: {
  maxIterations: number;
  stepNames: string[];
}): LoopState {
  return {
    iteration: 0,
    maxIterations,
    branch: "",
    iterationStartedAt: Date.now(),
    steps: stepNames.map(createLoopStep),
    focusedPane: "steps",
    selectedStepIndex: null,
    manualStepSelection: false,
    activeStepIndex: null,
    started: false,
    paused: false,
    quitting: false,
    stopAfterIteration: false,
    skipRequested: false,
    restartRequested: false,
    agentLines: [],
    agentLineTimes: [],
    stepOutputLines: stepNames.map(() => []),
    scrollIntent: null,
  };
}

let scrollIntentSeq = 0;

export function requestScrollIntent(state: LoopState, direction: ScrollDirection, stepIndex: number): void {
  scrollIntentSeq += 1;
  state.scrollIntent = { direction, stepIndex, seq: scrollIntentSeq };
  notifyStateChange();
}

export function consumeScrollIntent(state: LoopState, seq: number): void {
  if (state.scrollIntent?.seq !== seq) return;
  state.scrollIntent = null;
}

export function setFocusedPane(state: LoopState, focusedPane: LoopPane): void {
  if (state.focusedPane === focusedPane) return;
  state.focusedPane = focusedPane;
  notifyStateChange();
}

export function toggleFocusedPane(state: LoopState): LoopPane {
  state.focusedPane = state.focusedPane === "steps" ? "output" : "steps";
  notifyStateChange();
  return state.focusedPane;
}

export function setSelectedStepIndex(state: LoopState, stepIndex: number | null): void {
  const nextStepIndex = clampStepIndex(getStepCount(state), stepIndex);
  if (state.selectedStepIndex === nextStepIndex && state.manualStepSelection === (nextStepIndex !== null)) return;
  state.selectedStepIndex = nextStepIndex;
  state.manualStepSelection = nextStepIndex !== null;
  notifyStateChange();
}

export function selectPreviousStep(state: LoopState): number | null {
  const stepCount = getStepCount(state);
  if (stepCount === 0) return null;

  const currentStepIndex = clampStepIndex(stepCount, state.selectedStepIndex ?? state.activeStepIndex ?? stepCount - 1);
  const nextStepIndex = currentStepIndex === null ? null : Math.max(0, currentStepIndex - 1);
  if (state.selectedStepIndex !== nextStepIndex || !state.manualStepSelection) {
    state.selectedStepIndex = nextStepIndex;
    state.manualStepSelection = nextStepIndex !== null;
    notifyStateChange();
  }
  return nextStepIndex;
}

export function selectNextStep(state: LoopState): number | null {
  const stepCount = getStepCount(state);
  if (stepCount === 0) return null;

  const currentStepIndex = clampStepIndex(stepCount, state.selectedStepIndex ?? state.activeStepIndex ?? 0);
  const nextStepIndex = currentStepIndex === null ? null : Math.min(stepCount - 1, currentStepIndex + 1);
  if (state.selectedStepIndex !== nextStepIndex || !state.manualStepSelection) {
    state.selectedStepIndex = nextStepIndex;
    state.manualStepSelection = nextStepIndex !== null;
    notifyStateChange();
  }
  return nextStepIndex;
}

export function setStepSessionID(state: LoopState, stepIndex: number, sessionID: string): void {
  const step = state.steps[stepIndex];
  if (!step || step.sessionID === sessionID) return;
  step.sessionID = sessionID;
  notifyStateChange();
}

export function pushStepOutputLine(state: LoopState, stepIndex: number, line: string): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  step.outputLines.push(line);
  step.outputLineTimes.push(Date.now());
  trimStepOutputBuffer(step);
  if (step.outputPinnedToBottom) {
    step.outputScrollTop = Math.max(0, step.outputLines.length - 1);
  }
  notifyStateChange();
}

export function pushStepOutputLines(state: LoopState, stepIndex: number, lines: string[]): void {
  const step = state.steps[stepIndex];
  if (!step || lines.length === 0) return;
  const now = Date.now();
  step.outputLines.push(...lines);
  for (let i = 0; i < lines.length; i += 1) step.outputLineTimes.push(now);
  trimStepOutputBuffer(step);
  if (step.outputPinnedToBottom) {
    step.outputScrollTop = Math.max(0, step.outputLines.length - 1);
  }
  notifyStateChange();
}

export function trimStepOutputBuffer(step: LoopStep): void {
  const removed = trimPairedLines(step.outputLines, step.outputLineTimes);
  if (removed > 0) step.outputScrollTop = Math.max(0, step.outputScrollTop - removed);
}

export function setSelectedStepOutputScroll(state: LoopState, scrollTop: number, pinnedToBottom: boolean): void {
  const selectedStep = getSelectedStep(state);
  if (selectedStep === null) return;
  selectedStep.outputScrollTop = Math.max(0, scrollTop);
  selectedStep.outputPinnedToBottom = pinnedToBottom;
  notifyStateChange();
}

export function resetIterationNavigationState(state: LoopState): void {
  state.focusedPane = "steps";
  state.selectedStepIndex = clampStepIndex(getStepCount(state), state.activeStepIndex);
  state.manualStepSelection = false;
  for (const step of state.steps) {
    step.outputScrollTop = 0;
    step.outputPinnedToBottom = true;
  }
  notifyStateChange();
}

export function syncSelectionToActiveStep(state: LoopState): void {
  if (state.manualStepSelection) return;

  const nextStepIndex = clampStepIndex(getStepCount(state), state.activeStepIndex);
  if (state.selectedStepIndex === nextStepIndex) return;
  state.selectedStepIndex = nextStepIndex;
  notifyStateChange();
}

export function pushAgentLine(state: LoopState, line: string): void {
  state.agentLines.push(line);
  state.agentLineTimes.push(Date.now());
  trimPairedLines(state.agentLines, state.agentLineTimes);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notify(): void {
  if (notifyTimer !== undefined) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    for (const listener of [...listeners]) {
      listener();
    }
  }, NOTIFY_FRAME_MS);
}
