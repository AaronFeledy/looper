import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { resolvePermissionAction, type PermissionPolicy, type QuestionPolicy, type VariantConfig } from "../lib/config.ts";
import type { EventConsumerCallbacks, PermissionAskedPayload, QuestionAskedPayload } from "../lib/event-consumer.ts";
import { setPendingPermission, setPendingQuestion, setTodos, type LoopState, type StepRestartReason } from "../lib/state.ts";
import { formatRequestError, toError } from "./util.ts";

export type Step = {
  name: string;
  agent?: string;
  variant?: VariantConfig;
  model?: string;
  prompt: string;
  prefix?: string;
  suffix?: string;
  args?: string[];
  timeoutMs?: number;
  /** `true` = generate title at step end. `number` = N seconds after first assistant response, concurrently. `"branch"` = fire when the branch watcher detects a switch to a non-trivial branch; fallback to ~5min after first response or step end. See README. */
  title?: boolean | number | "branch";
  permissionPolicy?: PermissionPolicy;
  questionPolicy?: QuestionPolicy;
};

export type StepResult = "done" | "failed" | "skipped" | "restart" | "waiting";

export type StepRunResult = {
  status: StepResult;
  sessionID?: string;
  errorMessage?: string;
  messageID?: string;
  restartReason?: StepRestartReason;
};

export type RunnerEventControllerOptions = {
  state: LoopState;
  client: OpencodeClient;
  repoDir: string;
  step: Step;
  activeSessionID: string;
  pushLine: (line: string) => void;
  permissionPolicy?: PermissionPolicy;
  questionPolicy?: QuestionPolicy;
};

export function createRunnerEventController({
  state,
  client,
  repoDir,
  step,
  activeSessionID,
  pushLine,
  permissionPolicy,
  questionPolicy,
}: RunnerEventControllerOptions): Pick<
  EventConsumerCallbacks,
  "onPermissionAsked" | "onPermissionReplied" | "onQuestionAsked" | "onQuestionReplied" | "onQuestionRejected" | "onTodoUpdated"
> {
  const handledRequestIDs = new Set<string>();
  const inFlightReplies = new Map<string, Promise<void>>();
  const hasPermissionPolicy = permissionPolicy !== undefined || step.permissionPolicy !== undefined;
  const effectiveQuestionPolicy = step.questionPolicy ?? questionPolicy;

  const trackReply = (requestID: string, reply: Promise<void>): void => {
    inFlightReplies.set(requestID, reply);
    reply
      .then(() => {
        handledRequestIDs.add(requestID);
      })
      .catch((error) => {
        pushLine(`[looper] request ${requestID} reply failed: ${toError(error).message}`);
      })
      .finally(() => {
        inFlightReplies.delete(requestID);
      });
  };

  const alreadyHandling = (requestID: string): boolean => handledRequestIDs.has(requestID) || inFlightReplies.has(requestID);

  const onPermissionAsked = (payload: PermissionAskedPayload): void => {
    if (!hasPermissionPolicy) return;
    if (payload.sessionID !== activeSessionID) return;
    if (alreadyHandling(payload.requestID)) return;

    const action = resolvePermissionAction(payload.permission, step, { permissionPolicy });
    if (action === "ask") {
      pushLine(`[looper] permission '${payload.permission}' left pending (no policy; set permissionPolicy.${payload.permission} to allow or deny)`);
      return;
    }

    setPendingPermission(state, {
      requestID: payload.requestID,
      sessionID: payload.sessionID,
      permission: payload.permission,
      patterns: payload.patterns,
      ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    });

    const request = client.permission.reply({ requestID: payload.requestID, reply: action, directory: repoDir })
      .then((result) => {
        if (result.error) throw new Error(formatRequestError(result.error));
        pushLine(`[looper] permission '${payload.permission}' -> ${action}`);
      })
      .catch((error) => {
        throw error;
      })
      .finally(() => {
        setPendingPermission(state, null);
      });
    trackReply(payload.requestID, request);
  };

  const onQuestionAsked = (payload: QuestionAskedPayload): void => {
    if (effectiveQuestionPolicy !== "reject") return;
    if (payload.sessionID !== activeSessionID) return;
    if (alreadyHandling(payload.requestID)) return;

    setPendingQuestion(state, {
      requestID: payload.requestID,
      sessionID: payload.sessionID,
      questions: payload.questions,
    });

    const request = client.question.reject({ requestID: payload.requestID, directory: repoDir })
      .then((result) => {
        if (result.error) throw new Error(formatRequestError(result.error));
        pushLine(`[looper] question rejected (questionPolicy=${effectiveQuestionPolicy})`);
      })
      .catch((error) => {
        throw error;
      })
      .finally(() => {
        setPendingQuestion(state, null);
      });
    trackReply(payload.requestID, request);
  };

  return {
    onPermissionAsked,
    onPermissionReplied: (payload) => {
      if (payload.sessionID === activeSessionID) setPendingPermission(state, null);
    },
    onQuestionAsked,
    onQuestionReplied: (payload) => {
      if (payload.sessionID === activeSessionID) setPendingQuestion(state, null);
    },
    onQuestionRejected: (payload) => {
      if (payload.sessionID === activeSessionID) setPendingQuestion(state, null);
    },
    onTodoUpdated: (payload) => {
      if (payload.sessionID === activeSessionID) setTodos(state, payload.todos);
    },
  };
}

export class MalformedModelError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`model must be "provider/model" (e.g. "openai/gpt-5.5"); got "${model}"`);
    this.name = "MalformedModelError";
    this.model = model;
  }
}

// Backstop behind config.ts's optionalModelValue: a malformed model must fail
// the step loudly, never fall through to opencode's default (expensive) model.
export function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new MalformedModelError(model);
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
