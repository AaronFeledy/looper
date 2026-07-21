export type AssistantClassification =
  | { readonly kind: "done" }
  | { readonly kind: "empty"; readonly errorMessage: string }
  | { readonly kind: "failed"; readonly errorMessage: string }
  | { readonly kind: "in-progress" }
  | { readonly kind: "missing" };

export type SessionPendingState = "pending" | "idle" | "unknown";
export type SessionHealthState = SessionPendingState | "stopped";

export type PriorSessionEvaluation = {
  readonly statusKnown: boolean;
  readonly pending: boolean;
  readonly classification: AssistantClassification;
};
