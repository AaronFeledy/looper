import type { LooperEvent } from "../core/events.ts";
import type {
  PendingPermission,
  PendingQuestion,
  PendingRequest,
  PendingRequestDecisionAction,
  PendingRequestIdentity,
} from "../core/pending-request.ts";
import type { FinalizeStepStatus, StepRowView, TodoItem } from "../core/step-view.ts";
import type { RunControlView } from "./run-control.ts";

export type StepLifecyclePort = {
  /** Replaces state.ts `beginStepRun`. */
  readonly begin: (stepIndex: number, options?: { statusMessage?: string }) => void;
  /** Replaces state.ts `markStepWaiting`. */
  readonly markWaiting: (stepIndex: number) => void;
  /** Replaces the waiting-for-background row transition in opencode/reattach.ts. */
  readonly markWaitingForBackground: (stepIndex: number) => void;
  /** Replaces state.ts `finalizeStepRow`. */
  readonly finalize: (stepIndex: number, status: FinalizeStepStatus, options?: { statusMessage?: string }) => void;
  /** Replaces state.ts `setStepSessionID`. */
  readonly setSessionID: (stepIndex: number, sessionID: string) => void;
  /** Replaces state.ts `setStepPromptText`. */
  readonly setPromptText: (stepIndex: number, promptText: string) => void;
  /** Replaces state.ts `setStepLooperMessageIDs`. */
  readonly setLooperMessageIDs: (stepIndex: number, messageIDs: readonly string[]) => void;
  /** Replaces agent-tree-state.ts `setStepContinuation`. */
  readonly setContinuation: (stepIndex: number, value: { reason: string; since: number } | null) => void;
  /** Replaces the conditional status-message clear in opencode/reattach.ts. */
  readonly clearStatusMessageIf: (stepIndex: number, expected: string) => void;
  /** Replaces direct `state.steps[stepIndex]` reads. */
  readonly get: (stepIndex: number) => StepRowView | undefined;
};

export type StepOutputSink = {
  /** Replaces state.ts `pushAgentLine` plus `pushStepOutputLine`. */
  readonly line: (stepIndex: number, line: string, at?: number) => void;
  /** Replaces repeated state.ts `pushAgentLine` plus `pushStepOutputLines`. */
  readonly lines: (stepIndex: number, lines: string[], at?: number) => void;
  /** Replaces state.ts `pushAgentEvent` plus `pushStepOutputEvent`. */
  readonly event: (stepIndex: number, event: LooperEvent, at?: number) => void;
};

export type PendingRequestPort = {
  /** Replaces live reads of `state.pendingRequests`; callers must read again after mutations. */
  readonly list: () => readonly PendingRequest[];
  /** Replaces state.ts `enqueuePendingPermission`. */
  readonly enqueuePermission: (pending: PendingPermission) => void;
  /** Replaces state.ts `enqueuePendingQuestion`. */
  readonly enqueueQuestion: (pending: PendingQuestion) => void;
  /** Replaces state.ts `clearPendingRequests`. */
  readonly clearAll: () => void;
  /** Replaces state.ts `clearPendingRequest`. */
  readonly clearOne: (identity: PendingRequestIdentity) => boolean;
  /** Replaces state.ts `consumePendingRequestDecision`. */
  readonly consumeDecision: (identity: PendingRequestIdentity) => PendingRequestDecisionAction | null;
  /** Replaces state.ts `setPendingRequestError`. */
  readonly setError: (identity: PendingRequestIdentity, lastError: string) => boolean;
  /** Replaces state.ts `reopenPendingRequest`. */
  readonly reopen: (identity: PendingRequestIdentity, lastError: string) => boolean;
  /** Replaces state.ts `setTodos`. */
  readonly setTodos: (todos: TodoItem[]) => void;
};

export type StepReporter = {
  readonly steps: StepLifecyclePort;
  readonly out: StepOutputSink;
  readonly requests: PendingRequestPort;
  /** Replaces state.ts `notify`. */
  readonly notify: () => void;
};

export type RunStepContext = {
  readonly reporter: StepReporter;
  readonly control: RunControlView;
};
