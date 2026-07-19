import type { LooperEvent } from "../core/events.ts";

export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";

/** Terminal display statuses a step row settles into once its attempt is over. */
export type TerminalStepStatus = "done" | "failed" | "skipped";

/**
 * Statuses accepted by {@link finalizeStepRow}: the terminals plus `"restart"`,
 * which is a {@link StepStatus}-less signal that resets the row back to
 * `pending` (the runner returns `"restart"` as a {@link import("./runner.ts").StepResult},
 * never as a displayed status).
 */
export type FinalizeStepStatus = TerminalStepStatus | "restart";

export type LoopPane = "steps" | "output" | "github";

export type StepRestartReason = "manual" | "timeout";

export type ScrollDirection = "up" | "down" | "pageup" | "pagedown" | "home" | "end";

export type ScrollIntent = { direction: ScrollDirection; stepIndex: number; seq: number };

export type GithubCiOverall = "none" | "pending" | "passing" | "failing" | "neutral";

/**
 * Whether a PR can be merged cleanly into its base branch, mapped from
 * GitHub's `mergeable` field:
 * - `mergeable`: no conflicts; merges cleanly (MERGEABLE)
 * - `conflicting`: merge conflicts against the base (CONFLICTING)
 * - `unknown`: GitHub hasn't finished computing mergeability yet (UNKNOWN),
 *   which is the transient state right after a push
 */
export type GithubMergeable = "mergeable" | "conflicting" | "unknown";

/**
 * Status of Cursor Bugbot (a code-review check) when present on a PR.
 * Bugbot is surfaced apart from CI because its NEUTRAL conclusion is a signal
 * ("found issues"), not a skip. State meanings:
 * - `clean`: ran and found no issues (SUCCESS)
 * - `issues`: ran and found issues (NEUTRAL)
 * - `pending`: still running
 * - `error`: the check itself failed (FAILURE/TIMED_OUT/etc.)
 */
export type GithubBugbot = {
  state: "clean" | "issues" | "pending" | "error";
  /**
   * Count of unresolved review threads Bugbot raised. Only populated when
   * `state` is `issues` (we skip the extra API call otherwise); `undefined`
   * means "not fetched / unknown".
   */
  unresolved?: number;
};

export type GithubPr = {
  number: number;
  title: string;
  /** Upper-cased PR state: OPEN | MERGED | CLOSED. */
  state: string;
  isDraft: boolean;
  url: string;
  ciOverall: GithubCiOverall;
  ciPassing: number;
  ciFailing: number;
  ciPending: number;
  /** Checks with a NEUTRAL conclusion; tracked apart from passing. */
  ciNeutral: number;
  ciTotal: number;
  /** How cleanly the PR merges into its base; see {@link GithubMergeable}. */
  mergeable: GithubMergeable;
  /** Present only when a Cursor Bugbot check is attached to the PR head. */
  bugbot?: GithubBugbot;
};

/**
 * GitHub PR status for the current branch.
 * - `loading`: detection succeeded but the first query hasn't returned yet
 * - `no-pr`: GitHub repo but no PR is associated with the current branch
 * - `error`: `gh` failed (auth/network); surfaced as a muted hint
 * - `pr`: an associated PR with computed CI status
 */
export type GithubStatus =
  | { kind: "loading" }
  | { kind: "no-pr" }
  | { kind: "error"; message: string }
  | { kind: "pr"; pr: GithubPr };

export type PrdStatus =
  | { kind: "loading" }
  | { kind: "ok"; remaining: number; total: number }
  | { kind: "error"; message: string };

/**
 * Aggregate branch diff (committed + worktree changes) for the current branch
 * vs OpenCode's detected default branch, sourced live from OpenCode's VCS API.
 * `hidden` collapses the panel out of layout (on the default branch itself, or
 * before the first resolve); `ok` carries the panel's totals.
 */
export type BranchDiffStatus =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "ok"; additions: number; deletions: number; files: number }
  | { kind: "error"; message: string };

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
  outputEvents?: LooperEvent[];
  outputEventTimes?: number[];
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
  promptText?: string;
  looperMessageIDs?: string[];
  outputLines: string[];
  outputLineTimes: number[];
  outputEvents?: LooperEvent[];
  outputEventTimes?: number[];
  outputScrollTop: number;
  outputPinnedToBottom: boolean;
  backgroundAgents: BackgroundAgent[];
  restartReason?: StepRestartReason;
};

/** Cap retained output lines; rendering very large scrollback can starve TUI input. */
export const AGENT_MAX_LINES = 5_000;
/** Cap retained iteration-history entries (current-run, in-RAM); oldest dropped first. */
export const HISTORY_MAX_ENTRIES = 500;
const NOTIFY_FRAME_MS = 33;

export type HistoryStepSnapshot = {
  name: string;
  status: StepStatus;
  sessionID?: string;
  title?: string;
  promptText?: string;
  looperMessageIDs?: string[];
  restartReason?: StepRestartReason;
  startedAt?: number;
  finishedAt?: number;
};

export type IterationHistoryEntry = {
  iteration: number;
  branch: string;
  startedAt: number;
  steps: HistoryStepSnapshot[];
};

export type HistoryViewStatus = "empty" | "loading" | "ready" | "error";

export type HistoryView = {
  entryIndex: number;
  stepIndex: number;
  sessionKey: string | null;
  status: HistoryViewStatus;
  error?: string;
  lines: string[];
  lineTimes: number[];
  events: LooperEvent[];
  eventTimes: number[];
  outputScrollTop: number;
  outputPinnedToBottom: boolean;
};

export type RecoveryChoice = "restart" | "nudge" | "quit";

export type RecoveryPrompt = {
  stepName: string;
  reason: string;
  sessionID?: string;
};

export type PendingPermission = {
  requestID: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
};

export type PendingQuestion = {
  requestID: string;
  sessionID: string;
  questions: unknown[];
};

export type TodoItem = {
  content: string;
  status: string;
  priority: string;
};

export type EscConfirmMode = "reset" | "stop";

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
  recovery: RecoveryPrompt | null;
  pendingPermission: PendingPermission | null;
  pendingQuestion: PendingQuestion | null;
  todos: TodoItem[];
  recoveryChoice: RecoveryChoice | null;
  escConfirm: EscConfirmMode | null;
  helpVisible: boolean;
  promptModalVisible: boolean;
  configModalVisible: boolean;
  resumable: boolean;
  agentLines: string[];
  agentLineTimes: number[];
  agentEvents: LooperEvent[];
  agentEventTimes: number[];
  stepOutputLines: string[][];
  scrollIntent: ScrollIntent | null;
  github: GithubStatus;
  prd: PrdStatus;
  prdIterationBaseline: number | null;
  branchDiff: BranchDiffStatus;
  history: IterationHistoryEntry[];
  historyView: HistoryView | null;
};

export type FlatRow =
  | { kind: "step"; stepIndex: number }
  | { kind: "background"; stepIndex: number; sessionID: string };

type Listener = () => void;

const listeners = new Set<Listener>();
let notifyTimer: ReturnType<typeof setTimeout> | undefined;

/** The single constructor for a step row; defaults to a fresh `pending` row. */
export function createStepRow(
  name: string,
  overrides: { status?: StepStatus; title?: string; finishedAt?: number } = {},
): LoopStep {
  return {
    name,
    status: overrides.status ?? "pending",
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides.finishedAt !== undefined ? { finishedAt: overrides.finishedAt } : {}),
    outputLines: [],
    outputLineTimes: [],
    outputEvents: [],
    outputEventTimes: [],
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
    outputEvents: [],
    outputEventTimes: [],
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

function trimPairedEvents(events: LooperEvent[], times: number[]): number {
  const overflow = events.length - AGENT_MAX_LINES;
  if (overflow <= 0) return 0;
  events.splice(0, overflow);
  times.splice(0, overflow);
  return overflow;
}

function looperLogEventFromLine(line: string): LooperEvent | null {
  const prefix = "[looper] ";
  if (!line.startsWith(prefix)) return null;
  return { kind: "looper.log", message: line.slice(prefix.length) };
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
    steps: stepNames.map((name) => createStepRow(name)),
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
    recovery: null,
    pendingPermission: null,
    pendingQuestion: null,
    todos: [],
    recoveryChoice: null,
    escConfirm: null,
    helpVisible: false,
    promptModalVisible: false,
    configModalVisible: false,
    resumable: false,
    agentLines: [],
    agentLineTimes: [],
    agentEvents: [],
    agentEventTimes: [],
    stepOutputLines: stepNames.map(() => []),
    scrollIntent: null,
    github: { kind: "loading" },
    prd: { kind: "loading" },
    prdIterationBaseline: null,
    branchDiff: { kind: "hidden" },
    history: [],
    historyView: null,
  };
}

export function setPendingPermission(state: LoopState, pending: PendingPermission | null): void {
  state.pendingPermission = pending;
  notifyStateChange();
}

export function setPendingQuestion(state: LoopState, pending: PendingQuestion | null): void {
  state.pendingQuestion = pending;
  notifyStateChange();
}

export function setTodos(state: LoopState, todos: TodoItem[]): void {
  state.todos = todos;
  notifyStateChange();
}

export function setGithubStatus(state: LoopState, status: GithubStatus): void {
  if (JSON.stringify(state.github) === JSON.stringify(status)) return;
  state.github = status;
  if (state.focusedPane === "github" && status.kind !== "pr") {
    state.focusedPane = "steps";
  }
  notifyStateChange();
}

export function setPrdStatus(state: LoopState, status: PrdStatus): void {
  const changed = JSON.stringify(state.prd) !== JSON.stringify(status);
  if (status.kind === "ok" && state.prdIterationBaseline === null) {
    state.prdIterationBaseline = status.total - status.remaining;
  }
  if (!changed) return;
  state.prd = status;
  notifyStateChange();
}

export function setBranchDiffStatus(state: LoopState, status: BranchDiffStatus): void {
  if (JSON.stringify(state.branchDiff) === JSON.stringify(status)) return;
  state.branchDiff = status;
  notifyStateChange();
}

export function resetPrdIterationBaseline(state: LoopState): void {
  state.prdIterationBaseline = state.prd.kind === "ok" ? state.prd.total - state.prd.remaining : null;
}

export function prdPassingGain(status: PrdStatus, baseline: number | null): number {
  if (status.kind !== "ok" || baseline === null) return 0;
  return Math.max(0, status.total - status.remaining - baseline);
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

export function githubPrPanelVisible(state: LoopState): boolean {
  return state.github.kind === "pr";
}

function focusPaneCycle(state: LoopState): LoopPane[] {
  return githubPrPanelVisible(state) ? ["steps", "github", "output"] : ["steps", "output"];
}

export function nextFocusedPane(state: LoopState): LoopPane {
  const order = focusPaneCycle(state);
  const index = order.indexOf(state.focusedPane);
  return order[(index + 1) % order.length] ?? "steps";
}

export function focusPaneTabLabel(pane: LoopPane): string {
  if (pane === "github") return "PR";
  return pane;
}

export function toggleFocusedPane(state: LoopState): LoopPane {
  const next = nextFocusedPane(state);
  state.focusedPane = next;
  notifyStateChange();
  return state.focusedPane;
}

export function setSelectedStepIndex(state: LoopState, stepIndex: number | null): void {
  const nextStepIndex = clampStepIndex(getStepCount(state), stepIndex);
  const rejoiningLive =
    nextStepIndex !== null &&
    state.activeStepIndex !== null &&
    nextStepIndex === state.activeStepIndex;
  const nextManual = nextStepIndex !== null && !rejoiningLive;
  if (
    state.selectedStepIndex === nextStepIndex &&
    state.selectedBackgroundSessionID === null &&
    state.manualStepSelection === nextManual
  ) {
    if (rejoiningLive && pinStepOutputToBottom(state, nextStepIndex)) notifyStateChange();
    return;
  }
  state.selectedStepIndex = nextStepIndex;
  state.selectedBackgroundSessionID = null;
  state.manualStepSelection = nextManual;
  if (rejoiningLive) pinStepOutputToBottom(state, nextStepIndex);
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

/** Pin step output to bottom; returns true when the pin flag actually changed. */
function pinStepOutputToBottom(state: LoopState, stepIndex: number): boolean {
  const step = state.steps[stepIndex];
  if (!step || step.outputPinnedToBottom) return false;
  step.outputPinnedToBottom = true;
  return true;
}

function applyRowSelection(state: LoopState, row: FlatRow): void {
  const nextSessionID = row.kind === "background" ? row.sessionID : null;
  const rejoiningLive =
    row.kind === "step" &&
    state.activeStepIndex !== null &&
    row.stepIndex === state.activeStepIndex;
  const nextManual = !rejoiningLive;
  if (
    state.selectedStepIndex === row.stepIndex &&
    state.selectedBackgroundSessionID === nextSessionID &&
    state.manualStepSelection === nextManual
  ) {
    if (rejoiningLive && pinStepOutputToBottom(state, row.stepIndex)) notifyStateChange();
    return;
  }
  state.selectedStepIndex = row.stepIndex;
  state.selectedBackgroundSessionID = nextSessionID;
  state.manualStepSelection = nextManual;
  if (rejoiningLive) pinStepOutputToBottom(state, row.stepIndex);
  notifyStateChange();
}

export function selectFlatRow(state: LoopState, row: FlatRow): void {
  applyRowSelection(state, row);
}

export function selectHistoryStepAt(state: LoopState, stepIndex: number): void {
  const view = state.historyView;
  if (view === null) return;
  const entry = state.history[view.entryIndex];
  if (entry === undefined || entry.steps.length === 0) return;
  const nextStepIndex = Math.max(0, Math.min(entry.steps.length - 1, stepIndex));
  if (nextStepIndex === view.stepIndex) return;
  state.historyView = freshHistoryView(state, view.entryIndex, nextStepIndex);
  notifyStateChange();
}

export function selectStepListRow(state: LoopState, rowIndex: number): void {
  setFocusedPane(state, "steps");
  if (state.historyView !== null) {
    selectHistoryStepAt(state, rowIndex);
    return;
  }
  const row = flattenRows(state)[rowIndex];
  if (row === undefined) return;
  applyRowSelection(state, row);
}

export function insertRestartAttempt(state: LoopState, stepIndex: number, reason: StepRestartReason): number {
  const step = state.steps[stepIndex];
  if (!step) return stepIndex;
  step.restartReason = reason;
  step.status = "done";
  step.statusMessage = undefined;
  step.finishedAt = Date.now();
  const next = createStepRow(step.name, step.title !== undefined ? { title: step.title } : {});
  state.steps.splice(stepIndex + 1, 0, next);
  if (state.activeStepIndex !== null && state.activeStepIndex > stepIndex) state.activeStepIndex += 1;
  if (state.selectedStepIndex !== null && state.selectedStepIndex > stepIndex) state.selectedStepIndex += 1;
  notifyStateChange();
  return stepIndex + 1;
}

export function insertFailureRetryAttempt(state: LoopState, stepIndex: number): number {
  const step = state.steps[stepIndex];
  if (!step) return stepIndex;
  step.status = "failed";
  step.statusMessage = undefined;
  step.finishedAt = Date.now();
  const next = createStepRow(step.name, step.title !== undefined ? { title: step.title } : {});
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

/*
 * Step-row status transitions — the single place that moves a row's display
 * status and keeps its companion fields (statusMessage, startedAt, finishedAt,
 * state.activeStepIndex, backgroundAgents) in lockstep:
 *
 *   pending --beginStepRun--> running --finalizeStepRow--> done | failed | skipped
 *      ^                         |
 *      |                         +--markStepWaiting--> waiting --(resume)--> running
 *      +--finalizeStepRow("restart") / resetStepRowToPending--+
 *
 * The renderer (src/tui/step-list.ts) reads only `status` (+ restartReason);
 * notify() is debounced and idempotent within a frame, so folding it into these
 * helpers cannot let a listener observe a half-updated row.
 */

/**
 * pending -> running. Marks `stepIndex` active, syncs selection to it, and
 * (re)starts the row. `startedAt` is set once (`??=`) so a reattach of the same
 * row keeps its original start time.
 */
export function beginStepRun(state: LoopState, stepIndex: number, options: { statusMessage?: string } = {}): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  state.activeStepIndex = stepIndex;
  syncSelectionToActiveStep(state);
  step.status = "running";
  step.statusMessage = options.statusMessage;
  step.startedAt ??= Date.now();
  step.finishedAt = undefined;
  state.todos = [];
  notify();
}

/**
 * -> waiting. The row stays "live" (spinner) while its background tasks run but
 * yields no terminal status. Deliberately leaves `state.activeStepIndex` alone:
 * callers differ on whether the step is still active during the wait.
 */
export function markStepWaiting(state: LoopState, stepIndex: number): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  step.status = "waiting";
  step.statusMessage = undefined;
  notify();
}

/**
 * -> pending, in place (no row insertion). Resets a freshly-inserted
 * retry/restart row before its next attempt: preserves `startedAt`, clears
 * `finishedAt`, optionally shows a `statusMessage` (e.g. "retry in 5s").
 */
export function resetStepRowToPending(state: LoopState, stepIndex: number, options: { statusMessage?: string } = {}): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  step.status = "pending";
  step.statusMessage = options.statusMessage;
  step.finishedAt = undefined;
  notify();
}

/**
 * Runner finalization: running -> done | failed | skipped, or `"restart"` ->
 * pending. Clears the row's background-agent rows AND `state.activeStepIndex`.
 * Do NOT use for orchestrator inline failures that must keep background rows
 * visible — use {@link failStepRow}. `finishedAt` is stamped for every terminal
 * (including "skipped"); "restart" clears it instead.
 */
export function finalizeStepRow(
  state: LoopState,
  stepIndex: number,
  status: FinalizeStepStatus,
  options: { statusMessage?: string } = {},
): void {
  const step = state.steps[stepIndex];
  if (step) {
    if (status === "restart") {
      step.status = "pending";
      step.statusMessage = undefined;
      step.finishedAt = undefined;
    } else {
      step.status = status;
      step.statusMessage = options.statusMessage;
      step.finishedAt = Date.now();
    }
  }
  syncStepBackgroundAgents(state, stepIndex, []);
  state.activeStepIndex = null;
  notify();
}

/**
 * Orchestrator inline outcome: -> failed | skipped. Clears
 * `state.activeStepIndex` but PRESERVES background-agent rows — some inline
 * paths (e.g. the background-resume-limit branch) fire while a continuation
 * placeholder row is still installed, and clearing it would change visible TUI
 * state and selection.
 */
export function failStepRow(
  state: LoopState,
  stepIndex: number,
  status: "failed" | "skipped" = "failed",
  options: { statusMessage?: string } = {},
): void {
  const step = state.steps[stepIndex];
  if (step) {
    step.status = status;
    step.statusMessage = options.statusMessage;
    step.finishedAt = Date.now();
  }
  state.activeStepIndex = null;
  notify();
}

export function pushStepOutputLine(state: LoopState, stepIndex: number, line: string, at: number = Date.now()): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  step.outputLines.push(line);
  step.outputLineTimes.push(at);
  const event = looperLogEventFromLine(line);
  if (event !== null) {
    step.outputEvents ??= [];
    step.outputEventTimes ??= [];
    step.outputEvents.push(event);
    step.outputEventTimes.push(at);
    trimStepOutputEventBuffer(step);
  }
  trimStepOutputBuffer(step);
  if (step.outputPinnedToBottom) {
    step.outputScrollTop = Math.max(0, step.outputLines.length - 1);
  }
  notifyStateChange();
}

export function pushStepOutputLines(
  state: LoopState,
  stepIndex: number,
  lines: string[],
  at: number = Date.now(),
): void {
  const step = state.steps[stepIndex];
  if (!step || lines.length === 0) return;
  step.outputLines.push(...lines);
  for (let i = 0; i < lines.length; i += 1) step.outputLineTimes.push(at);
  const events = lines.map((line) => looperLogEventFromLine(line)).filter((event): event is LooperEvent => event !== null);
  if (events.length > 0) {
    step.outputEvents ??= [];
    step.outputEventTimes ??= [];
    step.outputEvents.push(...events);
    for (let i = 0; i < events.length; i += 1) step.outputEventTimes.push(at);
    trimStepOutputEventBuffer(step);
  }
  trimStepOutputBuffer(step);
  if (step.outputPinnedToBottom) {
    step.outputScrollTop = Math.max(0, step.outputLines.length - 1);
  }
  notifyStateChange();
}

export function pushStepOutputEvent(
  state: LoopState,
  stepIndex: number,
  event: LooperEvent,
  at: number = Date.now(),
): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  step.outputEvents ??= [];
  step.outputEventTimes ??= [];
  step.outputEvents.push(event);
  step.outputEventTimes.push(at);
  trimStepOutputEventBuffer(step);
  if (step.outputPinnedToBottom) {
    step.outputScrollTop = Math.max(0, Math.max(step.outputLines.length, step.outputEvents.length) - 1);
  }
  notifyStateChange();
}

export function pushStepOutputEvents(
  state: LoopState,
  stepIndex: number,
  events: readonly LooperEvent[],
  at: number = Date.now(),
): void {
  const step = state.steps[stepIndex];
  if (!step || events.length === 0) return;
  step.outputEvents ??= [];
  step.outputEventTimes ??= [];
  step.outputEvents.push(...events);
  for (let i = 0; i < events.length; i += 1) step.outputEventTimes.push(at);
  trimStepOutputEventBuffer(step);
  if (step.outputPinnedToBottom) {
    step.outputScrollTop = Math.max(0, Math.max(step.outputLines.length, step.outputEvents.length) - 1);
  }
  notifyStateChange();
}

export function trimStepOutputBuffer(step: LoopStep): void {
  const removed = trimPairedLines(step.outputLines, step.outputLineTimes);
  if (removed > 0) step.outputScrollTop = Math.max(0, step.outputScrollTop - removed);
}

function trimStepOutputEventBuffer(step: LoopStep): void {
  const removed = trimPairedEvents(step.outputEvents ?? [], step.outputEventTimes ?? []);
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

export function dismissEscConfirm(state: LoopState): void {
  if (state.escConfirm === null) return;
  state.escConfirm = null;
  notifyStateChange();
}

export function showHelp(state: LoopState): void {
  if (state.helpVisible) return;
  state.promptModalVisible = false;
  state.configModalVisible = false;
  state.helpVisible = true;
  notifyStateChange();
}

export function hideHelp(state: LoopState): void {
  if (!state.helpVisible) return;
  state.helpVisible = false;
  notifyStateChange();
}

export function setStepPromptText(state: LoopState, stepIndex: number, promptText: string): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  step.promptText = promptText;
  notifyStateChange();
}

export function setStepLooperMessageIDs(state: LoopState, stepIndex: number, messageIDs: readonly string[]): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  step.looperMessageIDs = [...messageIDs];
  notifyStateChange();
}

export function hydrateResumableBootStep(
  step: LoopStep,
  checkpoint: {
    readonly promptText?: string;
    readonly sessionID?: string;
    readonly looperMessageIDs?: readonly string[];
    readonly title?: string;
  },
): void {
  if (checkpoint.promptText !== undefined) step.promptText = checkpoint.promptText;
  if (checkpoint.sessionID !== undefined) step.sessionID = checkpoint.sessionID;
  if (checkpoint.looperMessageIDs !== undefined) step.looperMessageIDs = [...checkpoint.looperMessageIDs];
  if (checkpoint.title !== undefined) step.title = checkpoint.title;
}

export function selectedOrActiveStep(state: LoopState): LoopStep | null {
  const index = state.selectedStepIndex ?? state.activeStepIndex;
  if (index === null) return null;
  return state.steps[index] ?? null;
}

export function showPromptModal(state: LoopState): void {
  if (state.promptModalVisible) return;
  state.helpVisible = false;
  state.configModalVisible = false;
  state.promptModalVisible = true;
  notifyStateChange();
}

export function hidePromptModal(state: LoopState): void {
  if (!state.promptModalVisible) return;
  state.promptModalVisible = false;
  notifyStateChange();
}

export function togglePromptModal(state: LoopState): void {
  if (state.promptModalVisible) hidePromptModal(state);
  else showPromptModal(state);
}

export function showConfigModal(state: LoopState): void {
  if (state.configModalVisible) return;
  state.helpVisible = false;
  state.promptModalVisible = false;
  state.configModalVisible = true;
  notifyStateChange();
}

export function hideConfigModal(state: LoopState): void {
  if (!state.configModalVisible) return;
  state.configModalVisible = false;
  notifyStateChange();
}

export function toggleConfigModal(state: LoopState): void {
  if (state.configModalVisible) hideConfigModal(state);
  else showConfigModal(state);
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
  times?: readonly number[],
): void {
  if (lines.length === 0) return;
  const step = state.steps[stepIndex];
  if (!step) return;
  const agent = step.backgroundAgents.find((candidate) => candidate.sessionID === sessionID);
  if (!agent) return;
  const now = Date.now();
  agent.outputLines.push(...lines);
  if (times !== undefined && times.length === lines.length) {
    agent.outputLineTimes.push(...times);
  } else {
    for (let i = 0; i < lines.length; i += 1) agent.outputLineTimes.push(now);
  }
  const removed = trimPairedLines(agent.outputLines, agent.outputLineTimes);
  if (removed > 0) agent.outputScrollTop = Math.max(0, agent.outputScrollTop - removed);
  if (agent.outputPinnedToBottom) {
    agent.outputScrollTop = Math.max(0, agent.outputLines.length - 1);
  }
  notifyStateChange();
}

export function replaceBackgroundAgentEvents(
  state: LoopState,
  stepIndex: number,
  sessionID: string,
  events: readonly LooperEvent[],
  times?: readonly number[],
): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  const agent = step.backgroundAgents.find((candidate) => candidate.sessionID === sessionID);
  if (!agent) return;
  const now = Date.now();
  agent.outputEvents = [...events];
  agent.outputEventTimes =
    times !== undefined && times.length === events.length
      ? [...times]
      : events.map(() => now);
  trimPairedEvents(agent.outputEvents, agent.outputEventTimes);
  if (agent.outputPinnedToBottom) agent.outputScrollTop = Math.max(0, Math.max(agent.outputLines.length, agent.outputEvents.length) - 1);
  notifyStateChange();
}

export function clearBackgroundAgentBuffer(state: LoopState, stepIndex: number, sessionID: string): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  const agent = step.backgroundAgents.find((candidate) => candidate.sessionID === sessionID);
  if (!agent || agent.outputLines.length === 0) return;
  agent.outputLines = [];
  agent.outputLineTimes = [];
  agent.outputEvents = [];
  agent.outputEventTimes = [];
  agent.outputScrollTop = 0;
  agent.outputPinnedToBottom = true;
  notifyStateChange();
}

export function pushAgentLine(state: LoopState, line: string, at: number = Date.now()): void {
  state.agentLines.push(line);
  state.agentLineTimes.push(at);
  trimPairedLines(state.agentLines, state.agentLineTimes);
}

export function pushAgentEvent(state: LoopState, event: LooperEvent, at: number = Date.now()): void {
  state.agentEvents.push(event);
  state.agentEventTimes.push(at);
  trimPairedEvents(state.agentEvents, state.agentEventTimes);
}

export function snapshotIterationToHistory(state: LoopState): void {
  if (state.iteration < 1 || state.steps.length === 0) return;
  const steps: HistoryStepSnapshot[] = state.steps.map((step) => ({
    name: step.name,
    status: step.status,
    ...(step.sessionID !== undefined ? { sessionID: step.sessionID } : {}),
    ...(step.title !== undefined ? { title: step.title } : {}),
    ...(step.promptText !== undefined ? { promptText: step.promptText } : {}),
    ...(step.looperMessageIDs !== undefined ? { looperMessageIDs: [...step.looperMessageIDs] } : {}),
    ...(step.restartReason !== undefined ? { restartReason: step.restartReason } : {}),
    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
    ...(step.finishedAt !== undefined ? { finishedAt: step.finishedAt } : {}),
  }));
  state.history.push({ iteration: state.iteration, branch: state.branch, startedAt: state.iterationStartedAt, steps });
  const overflow = state.history.length - HISTORY_MAX_ENTRIES;
  if (overflow > 0) {
    state.history.splice(0, overflow);
    if (state.historyView !== null) state.historyView.entryIndex = Math.max(0, state.historyView.entryIndex - overflow);
  }
}

export function historyStepSessionKey(entryIndex: number, stepIndex: number, sessionID: string | undefined): string | null {
  if (sessionID === undefined) return null;
  return `${entryIndex}:${stepIndex}:${sessionID}`;
}

export function selectedHistoryStep(state: LoopState): { entry: IterationHistoryEntry; step: HistoryStepSnapshot; stepIndex: number } | null {
  const view = state.historyView;
  if (view === null) return null;
  const entry = state.history[view.entryIndex];
  if (entry === undefined) return null;
  const step = entry.steps[view.stepIndex];
  if (step === undefined) return null;
  return { entry, step, stepIndex: view.stepIndex };
}

function freshHistoryView(state: LoopState, entryIndex: number, stepIndex: number): HistoryView {
  const hasSession = state.history[entryIndex]?.steps[stepIndex]?.sessionID !== undefined;
  return {
    entryIndex,
    stepIndex,
    sessionKey: null,
    status: hasSession ? "loading" : "empty",
    lines: [],
    lineTimes: [],
    events: [],
    eventTimes: [],
    outputScrollTop: 0,
    outputPinnedToBottom: true,
  };
}

export function enterHistoryView(state: LoopState): boolean {
  if (state.history.length === 0) return false;
  state.historyView = freshHistoryView(state, state.history.length - 1, 0);
  state.focusedPane = "steps";
  notifyStateChange();
  return true;
}

export function exitHistoryView(state: LoopState): void {
  if (state.historyView === null) return;
  state.historyView = null;
  state.focusedPane = "steps";
  notifyStateChange();
}

export function historyMoveIteration(state: LoopState, delta: number): void {
  const view = state.historyView;
  if (view === null) return;
  const nextIndex = Math.max(0, Math.min(state.history.length - 1, view.entryIndex + delta));
  if (nextIndex === view.entryIndex) return;
  state.historyView = freshHistoryView(state, nextIndex, 0);
  notifyStateChange();
}

export function historyMoveStep(state: LoopState, delta: number): void {
  const view = state.historyView;
  if (view === null) return;
  const entry = state.history[view.entryIndex];
  if (entry === undefined || entry.steps.length === 0) return;
  const nextStepIndex = Math.max(0, Math.min(entry.steps.length - 1, view.stepIndex + delta));
  if (nextStepIndex === view.stepIndex) return;
  state.historyView = freshHistoryView(state, view.entryIndex, nextStepIndex);
  notifyStateChange();
}

export function setHistoryViewOutput(state: LoopState, sessionKey: string, lines: string[], times: number[]): void {
  const view = state.historyView;
  if (view === null) return;
  const expected = historyStepSessionKey(view.entryIndex, view.stepIndex, selectedHistoryStep(state)?.step.sessionID);
  if (expected !== sessionKey) return;
  view.sessionKey = sessionKey;
  view.lines = lines;
  view.lineTimes = times;
  view.status = lines.length > 0 ? "ready" : "empty";
  delete view.error;
  if (view.outputPinnedToBottom) view.outputScrollTop = Math.max(0, lines.length - 1);
  notifyStateChange();
}

export function setHistoryViewEvents(
  state: LoopState,
  sessionKey: string,
  events: readonly LooperEvent[],
  times?: readonly number[],
): void {
  const view = state.historyView;
  if (view === null) return;
  const expected = historyStepSessionKey(view.entryIndex, view.stepIndex, selectedHistoryStep(state)?.step.sessionID);
  if (expected !== sessionKey) return;
  const now = Date.now();
  view.sessionKey = sessionKey;
  view.events = [...events];
  view.eventTimes =
    times !== undefined && times.length === events.length
      ? [...times]
      : events.map(() => now);
  view.status = events.length > 0 ? "ready" : "empty";
  delete view.error;
  if (view.outputPinnedToBottom) view.outputScrollTop = Math.max(0, Math.max(view.lines.length, view.events.length) - 1);
  notifyStateChange();
}

export function setHistoryViewError(state: LoopState, sessionKey: string, message: string): void {
  const view = state.historyView;
  if (view === null) return;
  const expected = historyStepSessionKey(view.entryIndex, view.stepIndex, selectedHistoryStep(state)?.step.sessionID);
  if (expected !== sessionKey) return;
  view.sessionKey = sessionKey;
  view.status = "error";
  view.error = message;
  notifyStateChange();
}

export function setHistoryViewScroll(state: LoopState, scrollTop: number, pinnedToBottom: boolean): void {
  const view = state.historyView;
  if (view === null) return;
  view.outputScrollTop = Math.max(0, scrollTop);
  view.outputPinnedToBottom = pinnedToBottom;
  notifyStateChange();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function cancelPendingNotify(): void {
  if (notifyTimer === undefined) return;
  clearTimeout(notifyTimer);
  notifyTimer = undefined;
}

export function notify(): void {
  if (notifyTimer !== undefined) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    for (const listener of [...listeners]) {
      listener();
    }
  }, NOTIFY_FRAME_MS);
  notifyTimer.unref?.();
}
