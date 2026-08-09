import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import type { PermissionPolicy, QuestionPolicy, VariantConfig } from "../lib/config.ts";
import type { EventConsumerCallbacks } from "../lib/event-consumer.ts";
import type { LoopState, StepRestartReason } from "../lib/state.ts";
import { createRequestBroker } from "./request-broker.ts";

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
  ownedSessionIDs?: () => ReadonlySet<string>;
  unattended?: boolean;
};

export function createRunnerEventController(options: RunnerEventControllerOptions): Pick<
  EventConsumerCallbacks,
  "onPermissionAsked" | "onPermissionReplied" | "onQuestionAsked" | "onQuestionReplied" | "onQuestionRejected" | "onTodoUpdated"
> {
  return createRequestBroker({
    ...options,
    unattended: options.unattended ?? false,
    friction: { counts: new Map(), requestIDs: new Set() },
  }).callbacks;
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
