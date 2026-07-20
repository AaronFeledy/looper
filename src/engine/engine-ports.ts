import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2";

import type { ContextPolicy, PermissionPolicy, QuestionPolicy, RecoverySnapshotsConfig, TitleGenConfig } from "../lib/config.ts";
import type { Step, StepResult } from "../lib/runner.ts";
import type { LooperSessionMetadataInput } from "../lib/session-metadata.ts";
import type { RunState, StepSessionEntry } from "../lib/state-files.ts";
import type { RunStateAdvanceInput, RunStatePositionInput, RunStateStoreStep } from "../persistence/run-state-store.ts";
import type { AdjudicationRuntime } from "./adjudication-routing.ts";

export type { RunState, StepSessionEntry } from "../lib/state-files.ts";

export type RunStateStore = {
  readonly read: () => RunState | null;
  readonly saveResumeStep: (steps: readonly RunStateStoreStep[], stepIndex: number) => void;
  readonly saveNextResumeStep: (steps: readonly RunStateStoreStep[], nextIndex: number) => void;
  readonly savePosition: (input: RunStatePositionInput) => void;
  readonly saveAdvance: (input: RunStateAdvanceInput) => void;
  readonly clearForFreshRun: () => void;
  readonly clearRunArtifacts: () => void;
  readonly clearStopFiles: () => void;
  readonly stopReason: () => string;
  readonly stopFileExists: () => boolean;
  readonly stopAfterIterationFileExists: () => boolean;
  readonly writeStop: (reason: string) => void;
  readonly writeStopAfterIteration: (reason: string) => void;
};

export type RunEngineOptions = {
  readonly fresh: boolean;
  readonly maxIterations: number;
  readonly waitProvided: boolean;
  readonly waitDuration: number | "execution-time";
};

export type EngineIterationStart<S, Step> = {
  readonly state: S;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly steps: readonly Step[];
  readonly startStepIndex: number;
  readonly resumedPriorSteps: boolean;
};

export type EngineIterationComplete<S> = {
  readonly state: S;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly elapsedSeconds: number;
};

export type EngineWait<S> = {
  readonly state: S;
  readonly seconds: number;
  readonly label: string;
};

export type EngineRecoveryChoice = "restart" | "nudge" | "quit";

export type RunIterationHooks = {
  readonly onStepBegin?: (info: { readonly step: Step; readonly index: number; readonly totalSteps: number; readonly iteration: number; readonly title?: string }) => void;
  readonly onStepFinish?: (info: { readonly step: Step; readonly index: number; readonly nextIndex: number; readonly totalSteps: number; readonly iteration: number; readonly status: StepResult; readonly title?: string }) => void;
  readonly onStepSession?: (info: { readonly iteration: number; readonly index: number; readonly stepName: string; readonly sessionID: string; readonly messageID: string; readonly promptText?: string; readonly looperMessageIDs?: string[]; readonly title?: string }) => void;
  readonly onAdjudicationRoute?: (info: { readonly iteration: number; readonly totalSteps: number }) => void;
};

export type ResumeSession = {
  readonly sessionID?: string;
  readonly messageID?: string;
  readonly stepName?: string;
  readonly promptText?: string;
  readonly looperMessageIDs?: string[];
};

export type EngineStepFailure = {
  readonly message: string;
  readonly stepName?: string;
  readonly sessionID?: string;
};

export type EngineRecoveryRequest<S> = {
  readonly state: S;
  readonly error: EngineStepFailure;
};

export type EngineRecoveryResumeInput = {
  readonly choice: EngineRecoveryChoice;
  readonly failedSessionID?: string;
  readonly failedStepName?: string;
  readonly runState: RunState | null;
};

export type EngineFrontendHooks<S, Step = RunStateStoreStep> = {
  readonly createIterationState: (input: { readonly iteration: number; readonly maxIterations: number; readonly steps: readonly Step[]; readonly branch: string }) => S;
  readonly onIterationStart?: (input: EngineIterationStart<S, Step>) => void | Promise<void>;
  readonly onIterationComplete?: (input: EngineIterationComplete<S>) => void | Promise<void>;
  readonly onStopRequested?: (input: { readonly iteration: number; readonly reason: string; readonly phase: "before-iteration" | "after-iteration" }) => void | Promise<void>;
  readonly onMaxIterationsReached?: (input: { readonly maxIterations: number }) => void | Promise<void>;
  readonly waitBetweenIterations?: (input: EngineWait<S>) => Promise<void>;
  readonly onStepBegin?: RunIterationHooks["onStepBegin"];
  readonly onStepSession?: RunIterationHooks["onStepSession"];
  readonly onStepFinish?: RunIterationHooks["onStepFinish"];
  readonly onStepFailure?: (input: EngineRecoveryRequest<S>) => Promise<EngineRecoveryChoice>;
  readonly recoveryResumeForChoice?: (input: EngineRecoveryResumeInput) => ResumeSession | undefined;
  readonly onRecoveryRetry?: (input: { readonly state: S; readonly choice: EngineRecoveryChoice }) => void | Promise<void>;
};

export type EngineRunIterationInput<S, Step, Client> = {
  readonly state: S;
  readonly iteration: number;
  readonly client: Client;
  readonly repoDir: string;
  readonly configDir: string;
  readonly startStepIndex: number;
  readonly resume?: ResumeSession;
  readonly recoveryNudge?: boolean;
  readonly hooks?: RunIterationHooks;
  readonly titleGenConfig?: TitleGenConfig;
  readonly resumedPriorSteps?: boolean;
  readonly initialWorkDescription?: string;
  readonly looperRunID?: string;
  readonly recoverySnapshots?: RecoverySnapshotsConfig;
  readonly permissionPolicy?: PermissionPolicy;
  readonly questionPolicy?: QuestionPolicy;
  readonly useSessionIdle?: boolean;
  readonly prdDir?: string;
  readonly storyIdPattern?: string;
  readonly adjudication?: AdjudicationRuntime;
  readonly maxIterations?: number;
  readonly contextPolicy?: Partial<ContextPolicy>;
  readonly resumedStepSessions?: StepSessionEntry[];
  readonly stepsSnapshot: readonly Step[];
};

export type EngineRunIteration<S, Step, Client> = (input: EngineRunIterationInput<S, Step, Client>) => Promise<"complete" | "stopped">;

export type TitleAssistantEntry = { readonly info: Message; readonly parts: Part[] };

export type TitleModel = {
  readonly providerID: string;
  readonly modelID: string;
};

export type GenerateWorkDescriptionInput = {
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly contextText: string;
  readonly branchHint?: string;
  readonly config?: TitleGenConfig;
  readonly sessionProviderID?: string;
  readonly sessionMetadata?: LooperSessionMetadataInput;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
};

export type TitleService = {
  readonly humanizeBranchName: (branch: string) => string;
  readonly extractAssistantText: (entries: TitleAssistantEntry[]) => string;
  readonly extractAssistantModel: (entries: TitleAssistantEntry[]) => TitleModel | undefined;
  readonly generateWorkDescription: (input: GenerateWorkDescriptionInput) => Promise<string | undefined>;
};

export type RunEngineResult =
  | { readonly kind: "stopped"; readonly reason: string }
  | { readonly kind: "max-iterations" }
  | { readonly kind: "complete" };
