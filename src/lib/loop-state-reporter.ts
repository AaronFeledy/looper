import type { RunControlView } from "../engine/run-control.ts";
import type { RunStepContext, StepReporter } from "../engine/step-reporter.ts";
import { setStepContinuation } from "./agent-tree-state.ts";
import {
  beginStepRun,
  clearPendingRequest,
  clearPendingRequests,
  clearStepStatusMessageIf,
  consumePendingRequestDecision,
  enqueuePendingPermission,
  enqueuePendingQuestion,
  finalizeStepRow,
  markStepWaiting,
  markStepWaitingForBackground,
  notify,
  pushAgentEvent,
  pushAgentLine,
  pushStepOutputEvent,
  pushStepOutputLine,
  pushStepOutputLines,
  reopenPendingRequest,
  setPendingRequestError,
  setStepLooperMessageIDs,
  setStepPromptText,
  setStepSessionID,
  setTodos,
  type LoopState,
} from "./state.ts";

export function createLoopStateStepReporter(state: LoopState): StepReporter {
  return {
    steps: {
      begin: (stepIndex, options) => beginStepRun(state, stepIndex, options),
      markWaiting: (stepIndex) => markStepWaiting(state, stepIndex),
      markWaitingForBackground: (stepIndex) => markStepWaitingForBackground(state, stepIndex),
      finalize: (stepIndex, status, options) => finalizeStepRow(state, stepIndex, status, options),
      setSessionID: (stepIndex, sessionID) => setStepSessionID(state, stepIndex, sessionID),
      setPromptText: (stepIndex, promptText) => setStepPromptText(state, stepIndex, promptText),
      setLooperMessageIDs: (stepIndex, messageIDs) => setStepLooperMessageIDs(state, stepIndex, messageIDs),
      setContinuation: (stepIndex, value) => setStepContinuation(state, stepIndex, value),
      clearStatusMessageIf: (stepIndex, expected) => clearStepStatusMessageIf(state, stepIndex, expected),
      get: (stepIndex) => state.steps[stepIndex],
    },
    out: {
      line: (stepIndex, line, at) => {
        pushAgentLine(state, line, at);
        pushStepOutputLine(state, stepIndex, line, at);
      },
      lines: (stepIndex, lines, at) => {
        for (const line of lines) pushAgentLine(state, line, at);
        pushStepOutputLines(state, stepIndex, lines, at);
      },
      event: (stepIndex, event, at) => {
        pushAgentEvent(state, event, at);
        pushStepOutputEvent(state, stepIndex, event, at);
      },
    },
    requests: {
      list: () => state.pendingRequests,
      enqueuePermission: (pending) => enqueuePendingPermission(state, pending),
      enqueueQuestion: (pending) => enqueuePendingQuestion(state, pending),
      clearAll: () => clearPendingRequests(state),
      clearOne: (identity) => clearPendingRequest(state, identity),
      consumeDecision: (identity) => consumePendingRequestDecision(state, identity),
      setError: (identity, lastError) => setPendingRequestError(state, identity, lastError),
      reopen: (identity, lastError) => reopenPendingRequest(state, identity, lastError),
      setTodos: (todos) => setTodos(state, todos),
    },
    notify,
  };
}

export function loopStateRunStepContext(state: LoopState, control: RunControlView): RunStepContext {
  return { reporter: createLoopStateStepReporter(state), control };
}
