import type { OpencodeClient, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";

import type { PermissionPolicy, QuestionPolicy } from "../lib/config.ts";
import type { EventConsumerCallbacks } from "../lib/event-consumer.ts";
import type { LoopState } from "../lib/state.ts";
import type { Step } from "./step-runner-types.ts";

export type AutomatedRejectOrigin = "nontty_ask" | "gate_timeout" | "unattended_always_fail_closed";

export type RequestFrictionState = {
  readonly counts: Map<string, number>;
  readonly requestIDs: Set<string>;
};

export interface RequestBrokerScheduler {
  setTimeout(callback: () => void, milliseconds: number): object;
  clearTimeout(handle: object): void;
  setInterval(callback: () => void, milliseconds: number): object;
  clearInterval(handle: object): void;
}

export type RequestBrokerOptions = {
  readonly state: LoopState;
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly step: Step;
  readonly activeSessionID: string;
  readonly pushLine: (line: string) => void;
  readonly unattended: boolean;
  readonly permissionPolicy?: PermissionPolicy;
  readonly questionPolicy?: QuestionPolicy;
  readonly ownedSessionIDs?: () => ReadonlySet<string>;
  readonly friction: RequestFrictionState;
  readonly writeStop?: (reason: string) => void;
  readonly onSkip?: () => void;
  readonly gateMaxMs?: number;
  readonly claimPollMs?: number;
  readonly scheduler?: RequestBrokerScheduler;
  readonly now?: () => number;
  readonly onHumanGateChange?: (open: boolean) => void;
};

export type RequestListResults = {
  readonly permissions?: readonly PermissionRequest[];
  readonly questions?: readonly QuestionRequest[];
};

export type RequestBrokerCallbacks = Pick<
  EventConsumerCallbacks,
  "onPermissionAsked" | "onPermissionReplied" | "onQuestionAsked" | "onQuestionReplied" | "onQuestionRejected" | "onTodoUpdated"
>;

export type RequestBroker = {
  readonly callbacks: RequestBrokerCallbacks;
  readonly generation: number;
  readonly reconcile: (listResults: RequestListResults) => void;
  readonly rejectOpen: (reason: string) => Promise<void>;
  readonly consumeDecisions: () => Promise<void>;
  readonly stopAcceptingDecisions: () => void;
  readonly hasOpenRequests: () => boolean;
  readonly clearUI: () => void;
  readonly dispose: () => void;
};
