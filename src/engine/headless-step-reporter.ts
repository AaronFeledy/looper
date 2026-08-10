/**
 * Reference non-TTY StepReporter implementation and shared-contract double.
 * Runtime wiring into fallback.ts is deliberately deferred because
 * fallback output ordering currently rides the debounced global notify();
 * swapping reporters would reorder printed lines.
 */
import { looperLogEventFromLine, type LooperEvent } from "../core/events.ts";
import type {
  PendingPermission,
  PendingQuestion,
  PendingRequest,
  PendingRequestIdentity,
} from "../core/pending-request.ts";
import type { StepStatus, TodoItem } from "../core/step-view.ts";
import type { StepReporter } from "./step-reporter.ts";

type MutableStepRow = {
  name: string;
  status: StepStatus;
  statusMessage?: string;
  sessionID?: string;
  promptText?: string;
  looperMessageIDs?: readonly string[];
  startedAt?: number;
  finishedAt?: number;
  continuation?: { reason: string; since: number };
};

export type HeadlessStepReporterOptions = {
  readonly stepNames: readonly string[];
  readonly write?: (line: string) => void;
};

export type HeadlessStepReporterHarness = {
  readonly reporter: StepReporter;
  readonly rows: readonly MutableStepRow[];
  readonly stepLines: readonly (readonly string[])[];
  readonly stepEvents: readonly (readonly LooperEvent[])[];
  readonly agentLines: readonly string[];
  readonly readTodos: () => readonly TodoItem[];
};

function requestMatches(request: PendingRequest, identity: PendingRequestIdentity): boolean {
  return request.requestID === identity.requestID && request.generation === identity.generation;
}

export function createHeadlessStepReporterHarness(options: HeadlessStepReporterOptions): HeadlessStepReporterHarness {
  const rows: MutableStepRow[] = options.stepNames.map((name) => ({ name, status: "pending" }));
  const stepLines: string[][] = options.stepNames.map(() => []);
  const stepEvents: LooperEvent[][] = options.stepNames.map(() => []);
  const agentLines: string[] = [];
  let pendingRequests: PendingRequest[] = [];
  let todos: TodoItem[] = [];
  const write = options.write ?? (() => undefined);

  const enqueue = (pending: PendingRequest): void => {
    const index = pendingRequests.findIndex(({ requestID }) => requestID === pending.requestID);
    if (index === -1) {
      pendingRequests.push(pending);
      return;
    }
    const existing = pendingRequests[index];
    if (existing !== undefined && existing.generation === pending.generation) return;
    pendingRequests[index] = pending;
  };

  const reporter: StepReporter = {
    steps: {
      begin: (stepIndex, beginOptions = {}) => {
        const row = rows[stepIndex];
        if (row === undefined) return;
        row.status = "running";
        row.statusMessage = beginOptions.statusMessage;
        row.startedAt ??= Date.now();
        row.finishedAt = undefined;
        todos = [];
      },
      markWaiting: (stepIndex) => {
        const row = rows[stepIndex];
        if (row === undefined) return;
        row.status = "waiting";
        row.statusMessage = undefined;
      },
      markWaitingForBackground: (stepIndex) => {
        const row = rows[stepIndex];
        if (row === undefined) return;
        row.status = "waiting";
        row.finishedAt = undefined;
      },
      finalize: (stepIndex, status, finalizeOptions = {}) => {
        const row = rows[stepIndex];
        if (row === undefined) return;
        if (status === "restart") {
          row.status = "pending";
          row.statusMessage = undefined;
          row.finishedAt = undefined;
          return;
        }
        row.status = status;
        row.statusMessage = finalizeOptions.statusMessage;
        row.finishedAt = Date.now();
      },
      setSessionID: (stepIndex, sessionID) => {
        const row = rows[stepIndex];
        if (row !== undefined) row.sessionID = sessionID;
      },
      setPromptText: (stepIndex, promptText) => {
        const row = rows[stepIndex];
        if (row !== undefined) row.promptText = promptText;
      },
      setLooperMessageIDs: (stepIndex, messageIDs) => {
        const row = rows[stepIndex];
        if (row !== undefined) row.looperMessageIDs = [...messageIDs];
      },
      setContinuation: (stepIndex, value) => {
        const row = rows[stepIndex];
        if (row === undefined) return;
        if (value === null) delete row.continuation;
        else row.continuation = { ...value };
      },
      clearStatusMessageIf: (stepIndex, expected) => {
        const row = rows[stepIndex];
        if (row?.statusMessage === expected) row.statusMessage = undefined;
      },
      get: (stepIndex) => rows[stepIndex],
    },
    out: {
      line: (stepIndex, line) => {
        agentLines.push(line);
        write(line);
        const lines = stepLines[stepIndex];
        const events = stepEvents[stepIndex];
        if (lines === undefined || events === undefined) return;
        lines.push(line);
        const event = looperLogEventFromLine(line);
        if (event !== null) events.push(event);
      },
      lines: (stepIndex, lines) => {
        for (const line of lines) reporter.out.line(stepIndex, line);
      },
      event: (stepIndex, event) => {
        stepEvents[stepIndex]?.push(event);
      },
    },
    requests: {
      list: () => pendingRequests,
      enqueuePermission: (pending: PendingPermission) => enqueue({ kind: "permission", status: "open", ...pending }),
      enqueueQuestion: (pending: PendingQuestion) => enqueue({ kind: "question", status: "open", ...pending }),
      clearAll: () => {
        pendingRequests = [];
      },
      clearOne: (identity) => {
        const index = pendingRequests.findIndex((request) => requestMatches(request, identity));
        if (index === -1) return false;
        pendingRequests.splice(index, 1);
        return true;
      },
      consumeDecision: (identity) => {
        const request = pendingRequests.find((candidate) => requestMatches(candidate, identity));
        if (request?.status !== "resolving" || request.decision === undefined) return null;
        const decision = request.decision;
        delete request.decision;
        return decision;
      },
      setError: (identity, lastError) => {
        const request = pendingRequests.find((candidate) => requestMatches(candidate, identity));
        if (request === undefined) return false;
        request.status = "error";
        request.lastError = lastError;
        delete request.decision;
        return true;
      },
      reopen: (identity, lastError) => {
        const request = pendingRequests.find((candidate) => requestMatches(candidate, identity));
        if (request === undefined) return false;
        request.status = "open";
        request.lastError = lastError;
        delete request.decision;
        return true;
      },
      setTodos: (nextTodos) => {
        todos = nextTodos;
      },
    },
    notify: () => undefined,
  };

  return { reporter, rows, stepLines, stepEvents, agentLines, readTodos: () => todos };
}

export function createHeadlessStepReporter(options: HeadlessStepReporterOptions): StepReporter {
  return createHeadlessStepReporterHarness(options).reporter;
}
