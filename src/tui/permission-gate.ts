import type { PendingPermission, PendingQuestion } from "../lib/state.ts";

export type PermissionKeyAction = "once" | "always" | "reject" | "skip";
export type QuestionKeyAction = "reject" | "skip";
export type ModalFocusWinner = "recovery" | "escConfirm" | "permission" | "help" | "prompt" | "config" | "none";

type ModalFocusState = {
  readonly recovery: object | null;
  readonly escConfirm: string | null;
  readonly pendingRequests: readonly unknown[];
  readonly helpVisible: boolean;
  readonly promptModalVisible: boolean;
  readonly configModalVisible: boolean;
};

export function permissionModalLines(entry: PendingPermission): string[] {
  return [
    `Agent requests permission "${entry.permission}"`,
    ...(entry.patterns.length > 0 ? [`Patterns: ${entry.patterns.join(", ")}`] : []),
    "[y] once   [a] always   [d] deny   [s] deny + skip",
  ];
}

function questionText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const question = "question" in value && typeof value.question === "string" ? value.question : null;
  const header = "header" in value && typeof value.header === "string" ? value.header : null;
  if (question !== null && header !== null) return `${header}: ${question}`;
  return question ?? header;
}

export function questionModalLines(entry: PendingQuestion): string[] {
  const questions = entry.questions.map(questionText).filter((line): line is string => line !== null && line.length > 0);
  return [
    ...(questions.length > 0 ? questions : ["Agent asked a question."]),
    "To answer with text or choose an option, use an attached OpenCode client.",
    "[d] reject   [s] skip",
  ];
}

export function permissionKeyAction(key: string): PermissionKeyAction | null {
  switch (key.toLowerCase()) {
    case "y":
      return "once";
    case "a":
      return "always";
    case "d":
      return "reject";
    case "s":
      return "skip";
    default:
      return null;
  }
}

export function questionKeyAction(key: string): QuestionKeyAction | null {
  switch (key.toLowerCase()) {
    case "d":
      return "reject";
    case "s":
      return "skip";
    default:
      return null;
  }
}

export function modalFocusWinner(state: ModalFocusState): ModalFocusWinner {
  if (state.recovery !== null) return "recovery";
  if (state.escConfirm !== null) return "escConfirm";
  if (state.pendingRequests.length > 0) return "permission";
  if (state.helpVisible) return "help";
  if (state.promptModalVisible) return "prompt";
  if (state.configModalVisible) return "config";
  return "none";
}
