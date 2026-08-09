import { resolvePermissionAction } from "../lib/config.ts";
import {
  clearPendingRequest,
  consumePendingRequestDecision,
  enqueuePendingPermission,
  enqueuePendingQuestion,
  reopenPendingRequest,
  setPendingRequestError,
  setTodos,
  type PendingRequest,
  type PendingRequestDecisionAction,
} from "../lib/state.ts";
import { formatRequestError, toError } from "./util.ts";
import { AlreadyResolvedRequestError, createRequestBrokerScheduler, DEFAULT_CLAIM_POLL_MS, DEFAULT_GATE_MAX_MS, FRICTION_LIMIT, HANDLED_REQUEST_LIMIT, isAlreadyResolvedRequest } from "./request-broker-support.ts";
import type { PermissionAuditOrigin } from "./permission-audit.ts";
import type {
  AutomatedRejectOrigin,
  RequestBroker,
  RequestBrokerOptions,
  RequestListResults,
} from "./request-broker-types.ts";

export type {
  AutomatedRejectOrigin,
  RequestBroker,
  RequestBrokerOptions,
  RequestBrokerScheduler,
  RequestFrictionState,
  RequestListResults,
} from "./request-broker-types.ts";

let nextGeneration = 1;

export function createRequestBroker(options: RequestBrokerOptions): RequestBroker {
  const generation = nextGeneration++;
  const scheduler = options.scheduler ?? createRequestBrokerScheduler();
  const gateMaxMs = options.gateMaxMs ?? DEFAULT_GATE_MAX_MS;
  const handled = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const deadlines = new Map<string, object>();
  let disposed = false;
  let acceptingDecisions = true;
  const effectiveQuestionPolicy = options.step.questionPolicy ?? options.questionPolicy;
  const ownsSession = (sessionID: string): boolean =>
    sessionID === options.activeSessionID || options.ownedSessionIDs?.().has(sessionID) === true;
  const identity = (requestID: string) => ({ requestID, generation });
  const humanGateOpen = (): boolean => options.state.pendingRequests.some(
    (request) => request.generation === generation && request.status !== "resolving",
  );
  const reportHumanGate = (): void => options.onHumanGateChange?.(humanGateOpen());

  const rememberHandled = (requestID: string): void => {
    handled.add(requestID);
    if (handled.size <= HANDLED_REQUEST_LIMIT) return;
    const oldest = handled.values().next().value;
    if (typeof oldest === "string") handled.delete(oldest);
  };

  const clearDeadline = (requestID: string): void => {
    const handle = deadlines.get(requestID);
    if (handle !== undefined) scheduler.clearTimeout(handle);
    deadlines.delete(requestID);
  };

  const dismiss = (requestID: string): void => {
    clearDeadline(requestID);
    clearPendingRequest(options.state, identity(requestID));
    rememberHandled(requestID);
    reportHumanGate();
  };

  const incrementFriction = (request: Extract<PendingRequest, { kind: "permission" }>, origin: AutomatedRejectOrigin): void => {
    if (options.friction.requestIDs.has(request.requestID)) return;
    options.friction.requestIDs.add(request.requestID);
    const count = (options.friction.counts.get(request.permission) ?? 0) + 1;
    options.friction.counts.set(request.permission, count);
    if (count === FRICTION_LIMIT) options.writeStop?.(`permission friction: automated reject limit for '${request.permission}'`);
    options.pushLine(`[looper] permission '${request.permission}' automated reject origin=${origin}`);
  };

  const isAutomatedRejectOrigin = (origin: PermissionAuditOrigin): origin is AutomatedRejectOrigin =>
    origin === "nontty_ask" || origin === "gate_timeout" || origin === "unattended_always_fail_closed";

  const permissionReply = async (requestID: string, action: "once" | "always" | "reject"): Promise<void> => {
    const result = await options.client.permission.reply({ requestID, reply: action, directory: options.repoDir });
    if (result.error !== undefined) {
      if (isAlreadyResolvedRequest(result.error)) throw new AlreadyResolvedRequestError(formatRequestError(result.error));
      throw new Error(formatRequestError(result.error));
    }
  };

  const questionReject = async (requestID: string): Promise<void> => {
    const result = await options.client.question.reject({ requestID, directory: options.repoDir });
    if (result.error !== undefined) {
      if (isAlreadyResolvedRequest(result.error)) throw new AlreadyResolvedRequestError(formatRequestError(result.error));
      throw new Error(formatRequestError(result.error));
    }
  };

  const runWithRetry = async (request: PendingRequest, action: PendingRequestDecisionAction, origin: PermissionAuditOrigin): Promise<void> => {
    const reply = request.kind === "permission"
      ? () => permissionReply(request.requestID, action === "always" || action === "once" ? action : "reject")
      : () => questionReject(request.requestID);
    let lastError = "request failed";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await reply();
        if (request.kind === "permission") options.pushLine(`[looper] permission '${request.permission}' -> ${action}`);
        else options.pushLine("[looper] question rejected");
        if (request.kind === "permission" && isAutomatedRejectOrigin(origin)) incrementFriction(request, origin);
        dismiss(request.requestID);
        if (action === "skip") options.onSkip?.();
        return;
      } catch (error) {
        if (isAlreadyResolvedRequest(error)) {
          dismiss(request.requestID);
          return;
        }
        lastError = toError(error).message;
        setPendingRequestError(options.state, identity(request.requestID), lastError);
      }
    }
    reopenPendingRequest(options.state, identity(request.requestID), lastError);
    options.pushLine(`[looper] request ${request.requestID} reply failed after retry: ${lastError}`);
  };

  const submit = (request: PendingRequest, action: PendingRequestDecisionAction, origin: PermissionAuditOrigin, cleanup = false): void => {
    if (disposed || (!acceptingDecisions && !cleanup) || inFlight.has(request.requestID) || handled.has(request.requestID)) return;
    options.auditDecision?.({
      requestID: request.requestID,
      sessionID: request.sessionID,
      kind: request.kind,
      ...(request.kind === "permission" ? { permission: request.permission } : {}),
      action,
      origin,
    });
    const pending = runWithRetry(request, action, origin).finally(() => inFlight.delete(request.requestID));
    inFlight.set(request.requestID, pending);
  };

  const onDeadline = (requestID: string): void => {
    deadlines.delete(requestID);
    const request = options.state.pendingRequests.find((candidate) => candidate.requestID === requestID && candidate.generation === generation);
    if (request === undefined || request.status === "resolving") return;
    submit(request, "reject", "gate_timeout");
  };

  const armDeadline = (requestID: string, askedAt: number): void => {
    clearDeadline(requestID);
    const remaining = Math.max(1, askedAt + gateMaxMs - (options.now?.() ?? Date.now()));
    deadlines.set(requestID, scheduler.setTimeout(() => onDeadline(requestID), remaining));
  };

  const permissionAsked = (payload: Parameters<NonNullable<RequestBroker["callbacks"]["onPermissionAsked"]>>[0]): void => {
    if (!ownsSession(payload.sessionID) || handled.has(payload.requestID) || inFlight.has(payload.requestID)) return;
    // Reconcile re-lists open requests; keep an existing same-generation entry intact
    // (including a human claim the poller has not consumed yet).
    if (options.state.pendingRequests.some((candidate) => candidate.requestID === payload.requestID && candidate.generation === generation)) return;
    const askedAt = options.now?.() ?? Date.now();
    enqueuePendingPermission(options.state, {
      requestID: payload.requestID,
      sessionID: payload.sessionID,
      permission: payload.permission,
      patterns: payload.patterns,
      metadata: payload.metadata,
      generation,
      askedAt,
    });
    armDeadline(payload.requestID, askedAt);
    const request = options.state.pendingRequests.find((candidate) => candidate.requestID === payload.requestID && candidate.generation === generation);
    if (request?.kind !== "permission") return;
    const action = resolvePermissionAction(payload.permission, options.step, { permissionPolicy: options.permissionPolicy });
    if (!options.unattended && action === "ask") reportHumanGate();
    if (options.unattended && action === "ask") submit(request, "reject", "nontty_ask");
    else if (options.unattended && action === "always") {
      options.pushLine(`[error] permission '${payload.permission}' policy always rejected origin=unattended_always_fail_closed; unattended runs never send always`);
      submit(request, "reject", "unattended_always_fail_closed");
    } else if (action !== "ask") submit(request, action, "policy");
    else options.pushLine(`[looper] permission '${payload.permission}' left pending`);
  };

  const questionAsked = (payload: Parameters<NonNullable<RequestBroker["callbacks"]["onQuestionAsked"]>>[0]): void => {
    if (!ownsSession(payload.sessionID) || handled.has(payload.requestID) || inFlight.has(payload.requestID)) return;
    if (options.state.pendingRequests.some((candidate) => candidate.requestID === payload.requestID && candidate.generation === generation)) return;
    const askedAt = options.now?.() ?? Date.now();
    enqueuePendingQuestion(options.state, { requestID: payload.requestID, sessionID: payload.sessionID, questions: payload.questions, generation, askedAt });
    armDeadline(payload.requestID, askedAt);
    const request = options.state.pendingRequests.find((candidate) => candidate.requestID === payload.requestID && candidate.generation === generation);
    if (request?.kind !== "question") return;
    if (!options.unattended && effectiveQuestionPolicy !== "reject") reportHumanGate();
    if (options.unattended) submit(request, "reject", "nontty_ask");
    else if (effectiveQuestionPolicy === "reject") submit(request, "reject", "policy");
    else options.pushLine("[looper] question left pending");
  };

  const consumeDecisions = async (): Promise<void> => {
    const resolving = options.state.pendingRequests.filter((request) => request.generation === generation && request.status === "resolving");
    for (const request of resolving) {
      const action = consumePendingRequestDecision(options.state, identity(request.requestID));
      if (action !== null) submit(request, action, "human");
    }
    await Promise.all([...inFlight.values()]);
  };

  const callbacks: RequestBroker["callbacks"] = {
    onPermissionAsked: permissionAsked,
    onPermissionReplied: (payload) => { if (ownsSession(payload.sessionID)) dismiss(payload.requestID); },
    onQuestionAsked: questionAsked,
    onQuestionReplied: (payload) => { if (ownsSession(payload.sessionID)) dismiss(payload.requestID); },
    onQuestionRejected: (payload) => { if (ownsSession(payload.sessionID)) dismiss(payload.requestID); },
    onTodoUpdated: (payload) => { if (payload.sessionID === options.activeSessionID) setTodos(options.state, payload.todos); },
  };

  const reconcile = (results: RequestListResults): void => {
    const permissionIDs = results.permissions === undefined ? undefined : new Set(results.permissions.map(({ id }) => id));
    const questionIDs = results.questions === undefined ? undefined : new Set(results.questions.map(({ id }) => id));
    for (const request of [...options.state.pendingRequests]) {
      if (request.generation !== generation) continue;
      const listed = request.kind === "permission" ? permissionIDs : questionIDs;
      if (listed !== undefined && !listed.has(request.requestID)) dismiss(request.requestID);
    }
    for (const request of results.permissions ?? []) permissionAsked({ ...request, requestID: request.id, tool: request.tool });
    for (const request of results.questions ?? []) questionAsked({ ...request, requestID: request.id, tool: request.tool });
  };

  const poller = scheduler.setInterval(() => { void consumeDecisions(); }, options.claimPollMs ?? DEFAULT_CLAIM_POLL_MS);
  return {
    callbacks,
    generation,
    reconcile,
    consumeDecisions,
    stopAcceptingDecisions() {
      acceptingDecisions = false;
    },
    hasOpenRequests() {
      return options.state.pendingRequests.some((request) => request.generation === generation);
    },
    clearUI() {
      for (const request of [...options.state.pendingRequests]) {
        if (request.generation === generation) clearPendingRequest(options.state, identity(request.requestID));
      }
      reportHumanGate();
    },
    async rejectOpen(reason) {
      options.pushLine(`[looper] rejecting open requests: ${reason}`);
      for (const request of [...options.state.pendingRequests]) {
        if (request.generation === generation && request.status !== "resolving") submit(request, "reject", "teardown", true);
      }
      await Promise.all([...inFlight.values()]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.clearInterval(poller);
      for (const handle of deadlines.values()) scheduler.clearTimeout(handle);
      deadlines.clear();
    },
  };
}
