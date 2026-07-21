import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import type { Options } from "./args.ts";
import { loadSteps, type ContextPolicy, type PermissionPolicy, type QuestionPolicy, type RecoverySnapshotsConfig, type TitleGenConfig } from "./config.ts";
import { runIteration } from "./orchestrator.ts";
import { startOrAttachServer } from "./sdk-server.ts";
import { assertManagedOpencodeResourcesLoaded, LOOPER_MANAGED_RESOURCES } from "./opencode-managed-resources.ts";
import { assertAttachedServerLocation, assertConfiguredResourcesExist } from "./attached-server-agents.ts";
import type { LoopState } from "./state.ts";
import { resumeStepIndex, type StepSessionEntry } from "./state-files.ts";
import { createRunStateStore } from "../persistence/run-state-store.ts";
import { computeRunResumePlan, runEngine } from "../engine/run-engine.ts";
import type { ResumeSession } from "./orchestrator.ts";
import type { Step } from "./runner.ts";
import { createLooperRunID } from "./session-metadata.ts";
import { divider, label, ui } from "./fallback-ui.ts";
import { createAdjudicationStore, type AdjudicationStore } from "../persistence/adjudication-store.ts";
import { createAdjudicationConfig } from "../engine/adjudication-routing.ts";
import { createFallbackEngineHooks } from "./fallback-engine-hooks.ts";
import { createStoryStateStore, type StoryStateStore } from "../persistence/story-state-store.ts";

export type FallbackOptions = {
  options: Options;
  repoDir: string;
  configDir: string;
  opencodeBin: string;
  attachUrl?: string;
  validateResources?: boolean;
  titleGenConfig?: TitleGenConfig;
  recoverySnapshots?: RecoverySnapshotsConfig;
  permissionPolicy?: PermissionPolicy;
  questionPolicy?: QuestionPolicy;
  useSessionIdle?: boolean;
  prdDir?: string;
  prdFlipThreshold?: number;
  storyIdPattern?: string;
  contextPolicy?: Partial<ContextPolicy>;
  currentBranch: () => Promise<string>;
};

function configuredStepAgents(steps: readonly Step[]): string[] {
  const agents = new Set<string>();
  for (const step of steps) {
    if (step.agent !== undefined && step.agent.length > 0) agents.add(step.agent);
  }
  return [...agents];
}

export async function runNonTty({
  options,
  repoDir,
  configDir,
  opencodeBin,
  attachUrl,
  validateResources = false,
  titleGenConfig,
  recoverySnapshots = false,
  permissionPolicy,
  questionPolicy,
  useSessionIdle,
  prdDir,
  prdFlipThreshold: configuredPrdFlipThreshold,
  storyIdPattern,
  contextPolicy,
  currentBranch,
}: FallbackOptions): Promise<void> {
  const runStateStore = createRunStateStore({ configDir });
  const adjudicationStore = createAdjudicationStore({ configDir });
  const storyStateStore = createStoryStateStore({ configDir });
  runStateStore.clearStopFiles();
  if (options.fresh) {
    runStateStore.clearRunArtifacts();
    adjudicationStore.clearHistory();
    adjudicationStore.clearMarker();
    adjudicationStore.clearSession();
    storyStateStore.clear();
  }

  process.stdout.write(divider("Looper · OpenCode step runner", ui.magenta));
  process.stdout.write(`${label("Mode", "non-TTY fallback")}\n`);
  process.stdout.write(`${label("Branch", await currentBranch())}\n`);
  process.stdout.write(`${label("Config", configDir)}\n`);
  process.stdout.write(`${label("Steps", "reload from looper.yaml before each step")}\n`);
  process.stdout.write(`${ui.dim("│ edit looper.yaml while running to add, remove, or reorder steps")}\n`);

  const server = await startOrAttachServer({ opencodeBin, attachUrl });
  const client = createOpencodeClient({ baseUrl: server.url });

  try {
    if (attachUrl !== undefined) {
      await assertAttachedServerLocation({ client, repoDir, serverUrl: server.url });
      await assertManagedOpencodeResourcesLoaded({
        client,
        repoDir,
        serverUrl: server.url,
        requiredNames: LOOPER_MANAGED_RESOURCES.map((resource) => resource.name),
      });
    }
    if (validateResources) {
      await assertConfiguredResourcesExist({ client, repoDir, agents: configuredStepAgents(loadSteps(configDir)) });
    }
    await runNonTtyIterations({
      options,
      repoDir,
      configDir,
      client,
      ...(titleGenConfig !== undefined ? { titleGenConfig } : {}),
      recoverySnapshots,
      ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
      ...(questionPolicy !== undefined ? { questionPolicy } : {}),
      ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
      ...(prdDir !== undefined ? { prdDir } : {}),
      ...(configuredPrdFlipThreshold !== undefined ? { configuredPrdFlipThreshold } : {}),
      ...(storyIdPattern !== undefined ? { storyIdPattern } : {}),
      adjudicationStore,
      storyStateStore,
      ...(contextPolicy !== undefined ? { contextPolicy } : {}),
      currentBranch,
    });
  } finally {
    await server.close();
  }
}

/**
 * Iteration/step-index/session-resume plan for the non-TTY loop, isolated
 * from network/rendering concerns so it's directly unit-testable against a
 * scratch `configDir` and a written `.looper-run.json` (see
 * test/fallback-resume.test.ts). Mirrors main.ts's `computeResumePlan`, minus
 * the `title` field (fallback mode has no title-resume lifecycle) and minus
 * `looperRunID` (left to the caller, matching this file's pre-existing
 * looperRunID handling).
 */
export type NonTtyResumePlan = {
  startIteration: number;
  firstStartStepIndex: number;
  firstIterationResume: ResumeSession | undefined;
  /** Fixes a confirmed gap: unlike main.ts, this path never told
   * `runIteration` that a resumed mid-iteration start's prefix steps were
   * already `done` (they rendered as the default `skipped` instead). */
  firstIterationResumedPriorSteps: boolean;
  iterationStepSessions: StepSessionEntry[];
  /** True when the persisted iteration exceeded `options.maxIterations`
   * (stale state); the caller must also clear the on-disk pointer files and
   * mint a fresh `looperRunID` when this is true. */
  resetToFreshRun: boolean;
};

export function computeNonTtyResumePlan(configDir: string, options: Pick<Options, "fresh" | "maxIterations">): NonTtyResumePlan {
  const runStateStore = createRunStateStore({ configDir });
  const plan = computeRunResumePlan({
    fresh: options.fresh,
    maxIterations: options.maxIterations,
    steps: loadSteps(configDir),
    store: runStateStore,
    legacyResumeStepIndex: (steps) => resumeStepIndex([...steps]),
  });
  return {
    startIteration: plan.startIteration,
    firstStartStepIndex: plan.firstIterationStartStepIndex,
    firstIterationResume: plan.firstIterationResume,
    firstIterationResumedPriorSteps: plan.firstIterationStartStepIndex > 0 && plan.resumed,
    iterationStepSessions: plan.firstIterationStepSessions ?? [],
    resetToFreshRun: plan.resetToFreshRun,
  };
}

export async function runNonTtyIterations({
  options,
  repoDir,
  configDir,
  client,
  titleGenConfig,
  recoverySnapshots,
  permissionPolicy,
  questionPolicy,
  useSessionIdle,
  prdDir,
  configuredPrdFlipThreshold,
  storyIdPattern,
  adjudicationStore,
  storyStateStore,
  contextPolicy,
  currentBranch,
}: {
  options: Options;
  repoDir: string;
  configDir: string;
  client: ReturnType<typeof createOpencodeClient>;
  titleGenConfig?: TitleGenConfig;
  recoverySnapshots: RecoverySnapshotsConfig;
  permissionPolicy?: PermissionPolicy;
  questionPolicy?: QuestionPolicy;
  useSessionIdle?: boolean;
  prdDir?: string;
  configuredPrdFlipThreshold?: number;
  storyIdPattern?: string;
  adjudicationStore?: AdjudicationStore;
  storyStateStore?: StoryStateStore;
  contextPolicy?: Partial<ContextPolicy>;
  currentBranch: () => Promise<string>;
}): Promise<void> {
  const runStateStore = createRunStateStore({ configDir });
  const adjudication = createAdjudicationConfig({
    configDir,
    ...(adjudicationStore !== undefined ? { store: adjudicationStore } : {}),
    ...(configuredPrdFlipThreshold !== undefined ? { configuredThreshold: configuredPrdFlipThreshold } : {}),
  });
  const result = await runEngine<LoopState, typeof client>({
    fresh: options.fresh,
    maxIterations: options.maxIterations,
    waitProvided: options.waitProvided,
    waitDuration: options.waitDuration,
    repoDir,
    configDir,
    client,
    store: runStateStore,
    loadSteps: () => loadSteps(configDir),
    currentBranch,
    createLooperRunID,
    legacyResumeStepIndex: (steps) => resumeStepIndex([...steps]),
    runIteration,
    ...(storyStateStore !== undefined ? { storyState: storyStateStore } : {}),
    persistTitles: false,
    ...(titleGenConfig !== undefined ? { titleGenConfig } : {}),
    recoverySnapshots,
    ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
    ...(questionPolicy !== undefined ? { questionPolicy } : {}),
    ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
    ...(prdDir !== undefined ? { prdDir } : {}),
    ...(storyIdPattern !== undefined ? { storyIdPattern } : {}),
    adjudication,
    ...(contextPolicy !== undefined ? { contextPolicy } : {}),
    hooks: createFallbackEngineHooks(currentBranch),
  });
  if (result.kind === "max-iterations") process.exitCode = 1;
}
