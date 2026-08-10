export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";

/** Terminal display statuses a step row settles into once its attempt is over. */
export type TerminalStepStatus = "done" | "failed" | "skipped";

/**
 * Statuses accepted by finalizeStepRow: the terminals plus `"restart"`,
 * which is a StepStatus-less signal that resets the row back to
 * `pending` (the runner returns `"restart"` as a StepResult,
 * never as a displayed status).
 */
export type FinalizeStepStatus = TerminalStepStatus | "restart";

export type StepRestartReason = "manual" | "timeout";

export type TodoItem = {
  content: string;
  status: string;
  priority: string;
};

/** Readonly view of a step row for reporters/ports that must not depend on LoopState. */
export type StepRowView = {
  readonly name: string;
  readonly status: StepStatus;
  readonly statusMessage?: string;
  readonly sessionID?: string;
  readonly looperMessageIDs?: readonly string[];
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly title?: string;
};
