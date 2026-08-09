export type PendingPermission = {
  requestID: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  generation: number;
  askedAt?: number;
};

export type PendingQuestion = {
  requestID: string;
  sessionID: string;
  questions: unknown[];
  generation: number;
  askedAt?: number;
};

export type PendingRequestStatus = "open" | "resolving" | "error";
export type PendingRequestDecisionAction = "once" | "always" | "reject" | "skip";

type PendingRequestState = {
  status: PendingRequestStatus;
  decision?: PendingRequestDecisionAction;
  lastError?: string;
};

export type PendingRequest =
  | ({ kind: "permission" } & PendingPermission & PendingRequestState)
  | ({ kind: "question" } & PendingQuestion & PendingRequestState);

export type PendingRequestIdentity = {
  requestID: string;
  generation: number;
};

export type PendingRequestDecision = PendingRequestIdentity & {
  action: PendingRequestDecisionAction;
};
