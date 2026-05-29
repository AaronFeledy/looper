export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";

export type LoopPane = "steps" | "output";

export type StepRestartReason = "manual" | "timeout";

export type ScrollDirection = "up" | "down" | "pageup" | "pagedown" | "home" | "end";

export type ScrollIntent = { direction: ScrollDirection; stepIndex: number; seq: number };

/**
 * A live child opencode session spawned by a step's parent session (e.g. via
 * the task tool). Rendered as an indented sub-row beneath its parent step.
 * `outputLines` is empty until the user selects this row, at which point the
 * subscription manager starts feeding events into it; on deselect/end the
 * buffer is dropped to keep memory bounded.
 */
export type BackgroundAgent = {
  sessionID: string;
  agent?: string;
  title?: string;
  placeholder?: true;
  startedAt: number;
  outputLines: string[];
  outputLineTimes: number[];
  outputScrollTop: number;
  outputPinnedToBottom: boolean;
};

export type LoopStep = {
  name: string;
  status: StepStatus;
  statusMessage?: string;
  startedAt?: number;
  finishedAt?: number;
  sessionID?: string;
  /** Generated work-description from the title agent. Used as the output-box header suffix and as the session-title suffix. Reused across later steps in the same iteration. */
  title?: string;
  outputLines: string[];
  outputLineTimes: number[];
  outputScrollTop: number;
  outputPinnedToBottom: boolean;
  backgroundAgents: BackgroundAgent[];
  restartReason?: StepRestartReason;
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
  selectedBackgroundSessionID: string | null;
  manualStepSelection: boolean;
  activeStepIndex: number | null;
  started: boolean;
  paused: boolean;
  quitting: boolean;
  stopAfterIteration: boolean;
  skipRequested: boolean;
  restartRequested: boolean;
  restartReason?: StepRestartReason;
  agentLines: string[];
  agentLineTimes: number[];
  stepOutputLines: string[][];
  scrollIntent: ScrollIntent | null;
};

export type FlatRow =
  | { kind: "step"; stepIndex: number }
  | { kind: "background"; stepIndex: number; sessionID: string };

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
    backgroundAgents: [],
  };
}

export function backgroundAgentLabel(agent: BackgroundAgent): string {
  if (agent.title && agent.title.length > 0) return agent.title;
  if (agent.agent && agent.agent.length > 0) return agent.agent;
  return agent.sessionID.slice(-6);
}

export function createBackgroundAgent(
  sessionID: string,
  startedAt: number,
  fields: { agent?: string; title?: string; placeholder?: true } = {},
): BackgroundAgent {
  return {
    sessionID,
    startedAt,
    ...(fields.agent !== undefined ? { agent: fields.agent } : {}),
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.placeholder !== undefined ? { placeholder: fields.placeholder } : {}),
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
    selectedBackgroundSessionID: null,
    manualStepSelection: false,
    activeStepIndex: null,
    started: false,
    paused: false,
    quitting: false,
    stopAfterIteration: false,
    skipRequested: false,
    restartRequested: false,
    restartReason: undefined,
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
  if (
    state.selectedStepIndex === nextStepIndex &&
    state.selectedBackgroundSessionID === null &&
    state.manualStepSelection === (nextStepIndex !== null)
  ) {
    return;
  }
  state.selectedStepIndex = nextStepIndex;
  state.selectedBackgroundSessionID = null;
  state.manualStepSelection = nextStepIndex !== null;
  notifyStateChange();
}

export function flattenRows(state: LoopState): FlatRow[] {
  const rows: FlatRow[] = [];
  state.steps.forEach((step, stepIndex) => {
    rows.push({ kind: "step", stepIndex });
    for (const agent of step.backgroundAgents) {
      rows.push({ kind: "background", stepIndex, sessionID: agent.sessionID });
    }
  });
  return rows;
}

function currentRowIndex(state: LoopState, rows: FlatRow[]): number | null {
  if (rows.length === 0) return null;
  const stepIndex = state.selectedStepIndex ?? state.activeStepIndex;
  if (stepIndex === null) return null;
  const sessionID = state.selectedBackgroundSessionID;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (sessionID === null) {
      if (row.kind === "step" && row.stepIndex === stepIndex) return i;
    } else {
      if (row.kind === "background" && row.stepIndex === stepIndex && row.sessionID === sessionID) return i;
    }
  }
  return null;
}

function applyRowSelection(state: LoopState, row: FlatRow): void {
  const nextSessionID = row.kind === "background" ? row.sessionID : null;
  if (
    state.selectedStepIndex === row.stepIndex &&
    state.selectedBackgroundSessionID === nextSessionID &&
    state.manualStepSelection
  ) {
    return;
  }
  state.selectedStepIndex = row.stepIndex;
  state.selectedBackgroundSessionID = nextSessionID;
  state.manualStepSelection = true;
  notifyStateChange();
}

export function insertRestartAttempt(state: LoopState, stepIndex: number, reason: StepRestartReason): number {
  const step = state.steps[stepIndex];
  if (!step) return stepIndex;
  step.restartReason = reason;
  step.status = "done";
  step.statusMessage = undefined;
  step.finishedAt = Date.now();
  const next: LoopStep = {
    name: step.name,
    status: "pending",
    ...(step.title !== undefined ? { title: step.title } : {}),
    outputLines: [],
    outputLineTimes: [],
    outputScrollTop: 0,
    outputPinnedToBottom: true,
    backgroundAgents: [],
  };
  state.steps.splice(stepIndex + 1, 0, next);
  if (state.activeStepIndex !== null && state.activeStepIndex > stepIndex) state.activeStepIndex += 1;
  if (state.selectedStepIndex !== null && state.selectedStepIndex > stepIndex) state.selectedStepIndex += 1;
  notifyStateChange();
  return stepIndex + 1;
}

export function selectPreviousStep(state: LoopState): FlatRow | null {
  const rows = flattenRows(state);
  if (rows.length === 0) return null;
  const current = currentRowIndex(state, rows);
  const nextIndex = current === null ? rows.length - 1 : Math.max(0, current - 1);
  const next = rows[nextIndex]!;
  applyRowSelection(state, next);
  return next;
}

export function selectNextStep(state: LoopState): FlatRow | null {
  const rows = flattenRows(state);
  if (rows.length === 0) return null;
  const current = currentRowIndex(state, rows);
  const nextIndex = current === null ? 0 : Math.min(rows.length - 1, current + 1);
  const next = rows[nextIndex]!;
  applyRowSelection(state, next);
  return next;
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

function getSelectedBackgroundAgent(state: LoopState): BackgroundAgent | null {
  if (state.selectedBackgroundSessionID === null || state.selectedStepIndex === null) return null;
  const step = state.steps[state.selectedStepIndex];
  if (!step) return null;
  return step.backgroundAgents.find((agent) => agent.sessionID === state.selectedBackgroundSessionID) ?? null;
}

export function setSelectedStepOutputScroll(state: LoopState, scrollTop: number, pinnedToBottom: boolean): void {
  const target = getSelectedBackgroundAgent(state) ?? getSelectedStep(state);
  if (target === null) return;
  target.outputScrollTop = Math.max(0, scrollTop);
  target.outputPinnedToBottom = pinnedToBottom;
  notifyStateChange();
}

export function resetIterationNavigationState(state: LoopState): void {
  state.focusedPane = "steps";
  state.selectedStepIndex = clampStepIndex(getStepCount(state), state.activeStepIndex);
  state.selectedBackgroundSessionID = null;
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
  if (state.selectedStepIndex === nextStepIndex && state.selectedBackgroundSessionID === null) return;
  state.selectedStepIndex = nextStepIndex;
  state.selectedBackgroundSessionID = null;
  notifyStateChange();
}

export function syncStepBackgroundAgents(
  state: LoopState,
  stepIndex: number,
  next: { sessionID: string; agent?: string; title?: string; placeholder?: true; startedAt: number }[],
): void {
  const step = state.steps[stepIndex];
  if (!step) return;

  const existing = new Map(step.backgroundAgents.map((agent) => [agent.sessionID, agent] as const));
  const nextIDs = new Set(next.map((agent) => agent.sessionID));

  const merged: BackgroundAgent[] = [];
  let changed = step.backgroundAgents.length !== next.length;
  for (const incoming of next) {
    const prev = existing.get(incoming.sessionID);
    if (prev !== undefined) {
      if (incoming.agent !== undefined && prev.agent !== incoming.agent) {
        prev.agent = incoming.agent;
        changed = true;
      }
      if (incoming.title !== undefined && prev.title !== incoming.title) {
        prev.title = incoming.title;
        changed = true;
      }
      if (prev.placeholder !== incoming.placeholder) {
        if (incoming.placeholder === undefined) delete prev.placeholder;
        else prev.placeholder = incoming.placeholder;
        changed = true;
      }
      merged.push(prev);
    } else {
      merged.push(createBackgroundAgent(incoming.sessionID, incoming.startedAt, {
        ...(incoming.agent !== undefined ? { agent: incoming.agent } : {}),
        ...(incoming.title !== undefined ? { title: incoming.title } : {}),
        ...(incoming.placeholder !== undefined ? { placeholder: incoming.placeholder } : {}),
      }));
      changed = true;
    }
  }

  if (!changed) {
    for (let i = 0; i < merged.length; i += 1) {
      if (merged[i] !== step.backgroundAgents[i]) {
        changed = true;
        break;
      }
    }
  }

  step.backgroundAgents = merged;

  if (
    state.selectedBackgroundSessionID !== null &&
    state.selectedStepIndex === stepIndex &&
    !nextIDs.has(state.selectedBackgroundSessionID)
  ) {
    state.selectedBackgroundSessionID = null;
    changed = true;
  }

  if (changed) notifyStateChange();
}

export function pushBackgroundAgentLines(
  state: LoopState,
  stepIndex: number,
  sessionID: string,
  lines: string[],
): void {
  if (lines.length === 0) return;
  const step = state.steps[stepIndex];
  if (!step) return;
  const agent = step.backgroundAgents.find((candidate) => candidate.sessionID === sessionID);
  if (!agent) return;
  const now = Date.now();
  agent.outputLines.push(...lines);
  for (let i = 0; i < lines.length; i += 1) agent.outputLineTimes.push(now);
  const removed = trimPairedLines(agent.outputLines, agent.outputLineTimes);
  if (removed > 0) agent.outputScrollTop = Math.max(0, agent.outputScrollTop - removed);
  if (agent.outputPinnedToBottom) {
    agent.outputScrollTop = Math.max(0, agent.outputLines.length - 1);
  }
  notifyStateChange();
}

export function clearBackgroundAgentBuffer(state: LoopState, stepIndex: number, sessionID: string): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  const agent = step.backgroundAgents.find((candidate) => candidate.sessionID === sessionID);
  if (!agent || agent.outputLines.length === 0) return;
  agent.outputLines = [];
  agent.outputLineTimes = [];
  agent.outputScrollTop = 0;
  agent.outputPinnedToBottom = true;
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
