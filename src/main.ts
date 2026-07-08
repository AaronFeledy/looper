#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { BoxRenderable, createCliRenderer, type CliRenderer } from "@opentui/core";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join, resolve } from "node:path";

import { HelpRequested, parseArgs, resolveAttachUrl as resolveConfiguredAttachUrl } from "./lib/args.ts";
import { assertAttachedServerLocation, assertConfiguredResourcesExist, AttachedServerAgentError, AttachedServerLocationError } from "./lib/attached-server-agents.ts";
import { CONFIG_FILE_NAMES, findConfigFile, loadRuntimeConfig, loadSteps } from "./lib/config.ts";
import { startBackgroundAgentStreamer } from "./lib/background-agent-stream.ts";
import { runNonTty } from "./lib/fallback.ts";
import { waitWithCountdown } from "./lib/fallback-ui.ts";
import { runIteration } from "./lib/orchestrator.ts";
import { computeRunResumePlan, runEngine, type RunResumePlan } from "./engine/run-engine.ts";
import {
  applyManagedOpencodeResources,
  assertManagedOpencodeResourcesLoaded,
  DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS,
  LOOPER_MANAGED_RESOURCES,
} from "./lib/opencode-managed-resources.ts";
import { resumeSessionWorkState, type Step } from "./lib/runner.ts";
import { recoveryResumeForChoice, shouldAutoStartSavedSession } from "./lib/recovery-decisions.ts";
import { createLooperRunID } from "./lib/session-metadata.ts";
import { startOrAttachServer, type ServerHandle } from "./lib/sdk-server.ts";
import {
  cancelPendingNotify,
  createLoopState,
  createStepRow,
  dismissEscConfirm,
  type EscConfirmMode,
  notify,
  resetIterationNavigationState,
  resetPrdIterationBaseline,
  snapshotIterationToHistory,
} from "./lib/state.ts";
import { startHistoryStreamer } from "./lib/history-stream.ts";
import {
  resumeStepIndex,
  type StepSessionEntry,
} from "./lib/state-files.ts";
import { createRunStateStore, type RunStateStore } from "./persistence/run-state-store.ts";
import { createAgentStream } from "./tui/agent-stream.ts";
import { createBootScreen, type BootScreen } from "./tui/boot-screen.ts";
import { createFooter } from "./tui/footer.ts";
import { createGithubStatusPanel } from "./tui/github-status.ts";
import { createHeader } from "./tui/header.ts";
import { bindKeys, installBootInterruptHandler } from "./tui/keys.ts";
import { createRecoveryMenu } from "./tui/recovery-menu.ts";
import { createPrdPanel } from "./tui/prd-status.ts";
import { createStepList, LIST_WIDTH } from "./tui/step-list.ts";
import { createTodoPanel } from "./tui/todo-panel.ts";
import { createVcsSummaryPanel } from "./tui/vcs-summary.ts";
import { createWatcherEventHandler } from "./tui/watcher-events.ts";
import { startBranchWatcher, startGithubWatcher, startPrdWatcher, type BranchWatcherHandle } from "./watchers/setup.ts";
import type { GithubWatcher } from "./watchers/github.ts";
import type { PrdWatcher } from "./watchers/prd.ts";

const repoDir = process.env.LOOPER_REPO_DIR ? resolve(process.env.LOOPER_REPO_DIR) : process.cwd();
const opencodeAttachUrl = process.env.OPENCODE_ATTACH_URL ?? "http://127.0.0.1:4096";
const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";

// Auto-detected config-dir candidates, in resolution order. The first that
// already holds a config file wins; otherwise we default to the first (.looper).
const CONFIG_DIR_CANDIDATES = [
  join(repoDir, ".looper"),
  join(repoDir, ".local", "looper"),
  join(repoDir, ".local", ".looper"),
];

function resolveConfigDir(override: string | undefined): string {
  if (override !== undefined) return resolve(override);
  if (process.env.LOOPER_CONFIG_DIR) return resolve(process.env.LOOPER_CONFIG_DIR);
  const existing = CONFIG_DIR_CANDIDATES.find((candidate) => findConfigFile(candidate) !== undefined);
  return existing ?? CONFIG_DIR_CANDIDATES[0]!;
}

let configDir: string;

function ensureConfigDir(): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}

function ensureConfigExists(): void {
  if (findConfigFile(configDir) !== undefined) return;
  process.stderr.write(`error: missing ${CONFIG_FILE_NAMES[0]} in ${configDir} (looked for ${CONFIG_FILE_NAMES.join(", ")})\n`);
  process.stderr.write(`Create it with at least one step. See https://github.com/ for examples.\n`);
  process.exit(2);
}

async function currentBranch(): Promise<string> {
  const result = await $`git branch --show-current`.cwd(repoDir).quiet().nothrow();
  if (result.exitCode !== 0) return "unknown";
  return result.stdout.toString().trim() || "detached";
}

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function resetIterationState(
  state: ReturnType<typeof createLoopState>,
  iteration: number,
  branch: string,
  steps: Step[],
): void {
  snapshotIterationToHistory(state);
  state.iteration = iteration;
  state.branch = branch;
  state.iterationStartedAt = Date.now();
  state.activeStepIndex = null;
  state.started = true;
  state.skipRequested = false;
  state.restartRequested = false;
  state.restartReason = undefined;
  state.agentLines = [];
  state.agentEvents = [];
  state.agentEventTimes = [];
  state.stepOutputLines = steps.map(() => []);
  state.steps = steps.map((step) => createStepRow(step.name));
  resetIterationNavigationState(state);
  resetPrdIterationBaseline(state);
  notify();
}

async function waitForStart(state: ReturnType<typeof createLoopState>): Promise<void> {
  while (!state.started && !state.quitting && !state.stopAfterIteration) {
    notify();
    await Bun.sleep(100);
  }
}

async function waitForRecoveryChoice(state: ReturnType<typeof createLoopState>, runStateStore: RunStateStore): Promise<"restart" | "nudge" | "quit"> {
  while (state.recoveryChoice === null && !state.quitting && !runStateStore.stopFileExists() && !runStateStore.stopAfterIterationFileExists()) {
    notify();
    await Bun.sleep(100);
  }
  return state.recoveryChoice ?? "quit";
}

function resolveAttachUrl(
  options: ReturnType<typeof parseArgs>,
  runtimeConfig: ReturnType<typeof loadRuntimeConfig>,
): string | undefined {
  return resolveConfiguredAttachUrl(options, runtimeConfig.opencodeServerUrl, opencodeAttachUrl);
}

function configuredStepAgents(steps: readonly Step[]): string[] {
  const agents = new Set<string>();
  for (const step of steps) {
    if (step.agent !== undefined && step.agent.length > 0) agents.add(step.agent);
  }
  return [...agents];
}

async function runTui(options: ReturnType<typeof parseArgs>): Promise<number> {
  const runStateStore = createRunStateStore({ configDir });
  const steps = loadSteps(configDir);
  if (options.start) runStateStore.clearStopFiles();
  if (options.fresh) runStateStore.clearRunArtifacts();
  let looperRunID = runStateStore.read()?.looperRunID ?? createLooperRunID();

  const state = createLoopState({ maxIterations: options.maxIterations, stepNames: steps.map((step) => step.name) });
  state.branch = await currentBranch();
  state.started = options.start;

  // Re-read on-disk checkpoints both at boot and at go: a checkpoint edited
  // while the idle TUI was open must not be ignored (boot values go stale).
  type ResumePlan = RunResumePlan;
  const computeResumePlan = (planSteps: Step[]): ResumePlan => {
    const plan = computeRunResumePlan({
      fresh: options.fresh,
      maxIterations: options.maxIterations,
      steps: planSteps,
      store: runStateStore,
      legacyResumeStepIndex: (resumeSteps) => resumeStepIndex([...resumeSteps]),
    });
    looperRunID = plan.looperRunID ?? (plan.resetToFreshRun ? createLooperRunID() : looperRunID);
    return plan;
  };

  let { startIteration, firstIterationStartStepIndex, firstIterationResume, resumed: firstIterationResumed, firstIterationTitle, firstIterationStepSessions } =
    computeResumePlan(steps);

  // Iteration-scoped, in-memory ledger of the opencode sessionID each logical
  // step of the CURRENT iteration finished (or is in flight) with. Follows the
  // exact same lifecycle as `firstIterationTitle`/`firstIterationResumed`:
  // seeded here from a matching on-disk resume, replaced wholesale by
  // `applyResumePlan`/manual restart, and reset to `[]` the moment the loop
  // below crosses into a new iteration. Passed to `runIteration` as
  // `resumedStepSessions` only for the first iteration processed.
  let iterationStepSessions: StepSessionEntry[] = firstIterationStepSessions ?? [];

  const applyResumePlan = (plan: ResumePlan): void => {
    startIteration = plan.startIteration;
    firstIterationStartStepIndex = plan.firstIterationStartStepIndex;
    firstIterationResume = plan.firstIterationResume;
    firstIterationResumed = plan.resumed;
    firstIterationTitle = plan.firstIterationTitle;
    iterationStepSessions = plan.firstIterationStepSessions ?? [];
  };

  const autoStartIfSavedSessionRunning = async (client: ReturnType<typeof createOpencodeClient>): Promise<void> => {
    if (!shouldAutoStartSavedSession({
      started: state.started,
      fresh: options.fresh,
      stopFilePresent: runStateStore.stopFileExists(),
      stopAfterIterationFilePresent: runStateStore.stopAfterIterationFileExists(),
    })) return;
    const savedSteps = loadSteps(configDir);
    const plan = computeResumePlan(savedSteps);
    const sessionID = plan.firstIterationResume?.sessionID;
    const messageID = plan.firstIterationResume?.messageID;
    if (sessionID === undefined || messageID === undefined) return;
    const savedStep = savedSteps[plan.firstIterationStartStepIndex];
    const workState = await resumeSessionWorkState({
      client,
      repoDir,
      sessionID,
      statusTimeoutMs: DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS,
      ...(savedStep?.timeoutMs !== undefined ? { staleBusyThresholdMs: savedStep.timeoutMs } : {}),
      signal: bootAbort.signal,
    });
    if (workState !== "running") return;
    applyResumePlan(plan);
    firstIterationWasResumed = plan.resumed;
    firstIterationResumePoint = plan.firstIterationStartStepIndex;
    state.resumable = false;
    runStateStore.clearStopFiles();
    state.started = true;
  };

  // Snapshot the original resume point and "was resumed" flag computed from
  // on-disk state. These are used below to decide whether a manual Up/Down
  // selection that lands back on the checkpoint step should still pass
  // resumedPriorSteps (so the TUI shows prior steps as "done" rather than
  // "skipped"). Resetting the run clears both so a fresh manual start after
  // ESC reset does not inherit stale "resumed" semantics.
  let firstIterationWasResumed = firstIterationResumed;
  let firstIterationResumePoint = firstIterationStartStepIndex;

  // Make a resumable boot look like the prior run never exited: mark the
  // already-completed steps of the resume iteration as done and pre-select the
  // step we will resume on. On a clean slate, pre-select the first step so it is
  // obvious that pressing enter starts it.
  if (!state.started) {
    if (firstIterationResumed) {
      state.resumable = true;
      for (let i = 0; i < firstIterationStartStepIndex && i < state.steps.length; i += 1) {
        state.steps[i]!.status = "done";
      }
    }
    if (state.steps.length > 0) {
      state.selectedStepIndex = firstIterationResumed
        ? Math.min(firstIterationStartStepIndex, state.steps.length - 1)
        : 0;
      state.selectedBackgroundSessionID = null;
    }
  }
  let renderer: CliRenderer | undefined;
  let bootScreen: BootScreen | undefined;
  let booting = true;
  const bootAbort = new AbortController();
  let server: ServerHandle | undefined;
  let cleanupBootInterrupt: (() => void) | undefined;
  let cleanupKeys: (() => void) | undefined;
  let backgroundAgentStreamer: { stop: () => void } | undefined;
  let historyStreamer: { stop: () => void } | undefined;
  let branchWatcher: BranchWatcherHandle | undefined;
  let githubWatcher: GithubWatcher | undefined;
  let prdWatcher: PrdWatcher | undefined;
  let exitReason: string | undefined;
  const handleWatcherEvent = createWatcherEventHandler({ state, refreshGithub: () => githubWatcher?.refresh() });

  const finish = (exitCode: number, reason: string): number => {
    exitReason = reason;
    return exitCode;
  };

  const requestQuit = (reason: string) => {
    if (state.quitting) return;
    state.quitting = true;
    exitReason = reason;
    runStateStore.writeStop(reason);
    notify();
  };

  const requestStopAfterIteration = (reason: string) => {
    if (state.stopAfterIteration) return;
    state.stopAfterIteration = true;
    exitReason = reason;
    runStateStore.writeStopAfterIteration(reason);
    notify();
  };

  // Restore the terminal (raw mode / alt screen / mouse) before a hard exit so
  // the shell is left usable, then exit with the SIGINT convention code.
  let forceKilling = false;
  const ignoreForceKillCleanupError = (_error: unknown): void => {};
  const forceKill = (): never => {
    if (!forceKilling) {
      forceKilling = true;
      try {
        cleanupBootInterrupt?.();
        cleanupKeys?.();
      } catch (error) {
        ignoreForceKillCleanupError(error);
      }
      try {
        renderer?.destroy();
      } catch (error) {
        ignoreForceKillCleanupError(error);
      }
      void server?.close();
    }
    process.exit(130);
  };

  const FORCE_KILL_WINDOW_MS = 1_500;
  let lastInterruptAt = 0;
  const handleInterrupt = (reason: string) => {
    const now = Date.now();
    const doublePress = now - lastInterruptAt <= FORCE_KILL_WINDOW_MS;
    lastInterruptAt = now;
    if (doublePress || state.quitting) {
      forceKill();
      return;
    }
    requestStopAfterIteration(reason);
  };

  const throwIfBootAborted = () => {
    if (!bootAbort.signal.aborted) return;
    const reason = bootAbort.signal.reason;
    throw reason instanceof Error ? reason : new Error("looper startup interrupted");
  };

  const handleSigint = () => {
    if (booting) {
      requestQuit("SIGINT received during looper startup");
      bootScreen?.begin("Stopping startup");
      bootAbort.abort(new Error("looper startup interrupted by SIGINT"));
      return;
    }
    handleInterrupt("SIGINT received by looper TUI");
  };

  const handleSigterm = () => {
    requestQuit("SIGTERM received by looper TUI");
    if (booting) {
      bootScreen?.begin("Stopping startup");
      bootAbort.abort(new Error("looper startup interrupted by SIGTERM"));
    }
  };

  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      targetFps: 30,
      maxFps: 30,
    });
    cleanupBootInterrupt = installBootInterruptHandler(renderer, handleSigint);
    throwIfBootAborted();

    // Paint a status panel before the slow startup awaits below so the screen is
    // never blank; it is destroyed before the real UI root mounts.
    bootScreen = createBootScreen(renderer);

    bootScreen.begin("Watching branch");
    branchWatcher = await startBranchWatcher({
      repoDir,
      emit: handleWatcherEvent,
    });
    throwIfBootAborted();

    bootScreen.begin("Loading configuration");
    const runtimeConfig = loadRuntimeConfig(configDir, repoDir);
    const attachUrl = resolveAttachUrl(options, runtimeConfig);

    bootScreen.begin(attachUrl !== undefined ? `Attaching to opencode (${attachUrl})` : "Starting opencode server");
    server = await startOrAttachServer({ opencodeBin, attachUrl, signal: bootAbort.signal });
    throwIfBootAborted();

    bootScreen.begin("Connecting client");
    const client = createOpencodeClient({ baseUrl: server.url });
    if (attachUrl !== undefined) {
      bootScreen.begin("Validating server location");
      await assertAttachedServerLocation({ client, repoDir, serverUrl: server.url });
      throwIfBootAborted();
      bootScreen.begin("Validating managed resources");
      await assertManagedOpencodeResourcesLoaded({
        client,
        repoDir,
        serverUrl: server.url,
        requiredNames: LOOPER_MANAGED_RESOURCES.map((resource) => resource.name),
        signal: bootAbort.signal,
      });
      throwIfBootAborted();
    }

    if (runtimeConfig.validateResources) {
      bootScreen.begin("Validating configured resources");
      await assertConfiguredResourcesExist({ client, repoDir, agents: configuredStepAgents(steps), signal: bootAbort.signal });
      throwIfBootAborted();
    }

    bootScreen.begin("Checking saved session");
    await autoStartIfSavedSessionRunning(client);
    throwIfBootAborted();

    backgroundAgentStreamer = startBackgroundAgentStreamer({ state, client, repoDir });
    historyStreamer = startHistoryStreamer({ state, client, repoDir });

    const root = new BoxRenderable(renderer, {
      id: "looper-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
    });

    const body = new BoxRenderable(renderer, {
      id: "looper-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      columnGap: 1,
    });

    const stepList = createStepList(renderer, state);
    const stream = createAgentStream(renderer, state);
    const tuiRenderer = renderer;

    const leftColumn = new BoxRenderable(renderer, {
      id: "looper-left",
      width: LIST_WIDTH,
      height: "100%",
      flexDirection: "column",
    });
    leftColumn.add(stepList);
    bootScreen.begin("Detecting GitHub repository");
    githubWatcher = await startGithubWatcher({
      repoDir,
      getBranch: () => state.branch,
      emit: handleWatcherEvent,
      onEnabled: () => leftColumn.add(createGithubStatusPanel(tuiRenderer, state)),
    });
    throwIfBootAborted();
    leftColumn.add(createTodoPanel(renderer, state));
    leftColumn.add(createVcsSummaryPanel(renderer, state));
    prdWatcher = startPrdWatcher({
      prdDir: runtimeConfig.prdDir,
      emit: handleWatcherEvent,
      onEnabled: () => leftColumn.add(createPrdPanel(tuiRenderer, state)),
    });
    bootScreen.done();

    root.add(createHeader(renderer, state));
    body.add(leftColumn);
    body.add(stream);
    root.add(body);
    root.add(createRecoveryMenu(renderer, state));
    root.add(createFooter(renderer, state));

    bootScreen.destroy();
    bootScreen = undefined;
    renderer.root.add(root);

    const ESC_CONFIRM_MS = 3_000;
    let escConfirmTimer: ReturnType<typeof setTimeout> | undefined;
    const disarmEscConfirm = () => {
      if (escConfirmTimer !== undefined) {
        clearTimeout(escConfirmTimer);
        escConfirmTimer = undefined;
      }
      dismissEscConfirm(state);
    };
    const armEscConfirm = (mode: EscConfirmMode) => {
      if (escConfirmTimer !== undefined) clearTimeout(escConfirmTimer);
      state.escConfirm = mode;
      notify();
      escConfirmTimer = setTimeout(() => {
        escConfirmTimer = undefined;
        dismissEscConfirm(state);
      }, ESC_CONFIRM_MS);
      escConfirmTimer.unref?.();
    };
    const resetToFreshSlate = () => {
      runStateStore.clearRunArtifacts();
      startIteration = 1;
      firstIterationStartStepIndex = 0;
      firstIterationResume = undefined;
      firstIterationResumed = false;
      firstIterationWasResumed = false;
      firstIterationResumePoint = 0;
      firstIterationTitle = undefined;
      iterationStepSessions = [];
      const freshSteps = loadSteps(configDir);
      state.steps = freshSteps.map((step) => createStepRow(step.name));
      state.stepOutputLines = freshSteps.map(() => []);
      state.agentEvents = [];
      state.agentEventTimes = [];
      state.selectedStepIndex = freshSteps.length > 0 ? 0 : null;
      state.selectedBackgroundSessionID = null;
      state.manualStepSelection = false;
      state.activeStepIndex = null;
      state.resumable = false;
      notify();
    };
    const handleEscape = () => {
      if (state.recovery !== null || state.historyView !== null) {
        disarmEscConfirm();
        return;
      }
      if (state.started) {
        if (state.escConfirm === "stop") {
          disarmEscConfirm();
          requestQuit("stopped from looper TUI");
          return;
        }
        armEscConfirm("stop");
        return;
      }
      if (state.resumable) {
        if (state.escConfirm === "reset") {
          disarmEscConfirm();
          resetToFreshSlate();
          return;
        }
        armEscConfirm("reset");
        return;
      }
      disarmEscConfirm();
    };

    const beginRun = () => {
      disarmEscConfirm();
      state.resumable = false;
      runStateStore.clearStopFiles();
      if (options.fresh) runStateStore.clearRunArtifacts();
      if (!state.started) {
        if (state.manualStepSelection && state.selectedStepIndex !== null) {
          firstIterationStartStepIndex = state.selectedStepIndex;
          firstIterationResume = undefined;
          // If the idle boot was a checkpoint resume and the user selected at/after
          // that checkpoint, the prefix steps were done in a prior process → pass
          // resumedPriorSteps so they render "done", not "skipped".
          firstIterationResumed = firstIterationWasResumed && (state.selectedStepIndex >= firstIterationResumePoint);
          // Clear the title and prior step sessions only if selecting before
          // the checkpoint; keep both if resuming at/after the checkpoint so
          // inherited-title steps and the context block still see them.
          if (!firstIterationResumed) {
            firstIterationTitle = undefined;
            iterationStepSessions = [];
          }
        } else {
          applyResumePlan(computeResumePlan(loadSteps(configDir)));
        }
      }
      state.started = true;
      state.stopAfterIteration = false;
      state.quitting = false;
      notify();
    };

    cleanupBootInterrupt?.();
    cleanupBootInterrupt = undefined;

    cleanupKeys = bindKeys(renderer, state, {
      onEscape: () => {
        handleEscape();
      },
      onQuit: () => {
        requestQuit("quit requested from looper TUI");
      },
      onInterrupt: () => {
        handleInterrupt("Ctrl-C received by looper TUI");
      },
      onRecoveryChoice: (choice) => {
        if (state.recovery === null) return;
        state.recoveryChoice = choice;
        if (choice === "quit") requestQuit("quit requested from recovery menu");
        notify();
      },
      onSkip: () => {
        if (state.activeStepIndex === null) return;
        state.skipRequested = true;
        notify();
      },
      onStart: () => {
        beginRun();
      },
      onRestart: () => {
        if (state.activeStepIndex === null) return;
        state.restartRequested = true;
        state.restartReason = "manual";
        notify();
      },
      onStopAfterIteration: () => {
        requestStopAfterIteration("finish current iteration, then stop");
      },
      onTogglePause: () => {
        state.paused = !state.paused;
        notify();
      },
    });

    throwIfBootAborted();
    booting = false;

    await waitForStart(state);

    let recoveryExitReason: string | undefined;
    const engineResult = await runEngine<ReturnType<typeof createLoopState>, typeof client>({
      fresh: options.fresh,
      maxIterations: options.maxIterations,
      waitProvided: options.waitProvided,
      waitDuration: options.waitDuration,
      repoDir,
      configDir,
      client,
      store: runStateStore,
      loadSteps: () => loadSteps(configDir),
      currentBranch: async () => state.branch || (await currentBranch()),
      createLooperRunID,
      legacyResumeStepIndex: (resumeSteps) => resumeStepIndex([...resumeSteps]),
      runIteration: (input) => runIteration(input),
      initialPlan: {
        startIteration,
        firstIterationStartStepIndex,
        firstIterationResume,
        resumed: firstIterationResumed,
        firstIterationTitle,
        firstIterationStepSessions: iterationStepSessions.length > 0 ? iterationStepSessions : undefined,
        resetToFreshRun: false,
        looperRunID,
      },
      ...(runtimeConfig.title !== undefined ? { titleGenConfig: runtimeConfig.title } : {}),
      ...(runtimeConfig.permissionPolicy !== undefined ? { permissionPolicy: runtimeConfig.permissionPolicy } : {}),
      ...(runtimeConfig.questionPolicy !== undefined ? { questionPolicy: runtimeConfig.questionPolicy } : {}),
      ...(runtimeConfig.contextPolicy !== undefined ? { contextPolicy: runtimeConfig.contextPolicy } : {}),
      ...(runtimeConfig.prdDir !== undefined ? { prdDir: runtimeConfig.prdDir } : {}),
      useSessionIdle: runtimeConfig.useSessionIdle,
      vcsSummary: runtimeConfig.vcsSummary,
      recoverySnapshots: runtimeConfig.recovery.snapshots,
      elapsedSeconds,
      hooks: {
        createIterationState: ({ iteration, steps, branch }) => {
          resetIterationState(state, iteration, branch, [...steps]);
          return state;
        },
        onStepBegin: () => {
          branchWatcher?.refresh();
          githubWatcher?.refresh();
        },
        onStepFinish: () => {
          branchWatcher?.refresh();
          githubWatcher?.refresh();
        },
        onStepFailure: async ({ error }) => {
          state.started = false;
          state.paused = false;
          state.recovery = {
            stepName: error.stepName ?? "step",
            reason: error.message,
            ...(error.sessionID !== undefined ? { sessionID: error.sessionID } : {}),
          };
          state.recoveryChoice = null;
          notify();
          const choice = await waitForRecoveryChoice(state, runStateStore);
          state.recovery = null;
          state.recoveryChoice = null;
          notify();
          if (choice === "quit" || state.quitting || state.stopAfterIteration || runStateStore.stopFileExists() || runStateStore.stopAfterIterationFileExists()) {
            recoveryExitReason = exitReason ?? error.message;
            return "quit";
          }
          return choice;
        },
        recoveryResumeForChoice: ({ choice, failedSessionID, failedStepName, runState }) => recoveryResumeForChoice({ choice, failedSessionID, failedStepName, runState }),
        onRecoveryRetry: () => {
          disarmEscConfirm();
          state.resumable = false;
          state.started = true;
          state.paused = false;
          state.stopAfterIteration = false;
          state.quitting = false;
          notify();
        },
        waitBetweenIterations: async ({ seconds, label: waitLabel }) => {
          await waitWithCountdown(state, seconds, waitLabel, true);
        },
      },
    });
    if (recoveryExitReason !== undefined) return finish(1, recoveryExitReason);
    if (engineResult.kind === "stopped") return finish(0, exitReason ?? engineResult.reason);
    if (engineResult.kind === "max-iterations") return finish(1, `max iterations reached (${options.maxIterations})`);
    return finish(0, "complete");
  } catch (error) {
    if (bootAbort.signal.aborted) return finish(130, exitReason ?? "looper startup interrupted");
    throw error;
  } finally {
    cleanupBootInterrupt?.();
    cleanupKeys?.();
    backgroundAgentStreamer?.stop();
    historyStreamer?.stop();
    githubWatcher?.stop();
    prdWatcher?.stop();
    branchWatcher?.stop();
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    cancelPendingNotify();
    bootScreen?.destroy();
    renderer?.destroy();
    await server?.close();
    if (exitReason !== undefined) process.stdout.write(`Looper exited: ${exitReason}\n`);
  }
}

async function main(): Promise<number> {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(Bun.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(error.message);
      return 0;
    }
    throw error;
  }

  configDir = resolveConfigDir(options.configDir);
  ensureConfigDir();
  ensureConfigExists();
  applyManagedOpencodeResources({ resources: LOOPER_MANAGED_RESOURCES, log: (line) => process.stderr.write(`${line}\n`) });

  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTty) {
    if (!options.start) {
      process.stdout.write("Looper not started. Re-run with --start in non-TTY mode, or use the TUI and press [g]o.\n");
      return 0;
    }

    const runtimeConfig = loadRuntimeConfig(configDir, repoDir);
    await runNonTty({
      options,
      repoDir,
      configDir,
      opencodeBin,
      attachUrl: resolveAttachUrl(options, runtimeConfig),
      validateResources: runtimeConfig.validateResources,
      ...(runtimeConfig.title !== undefined ? { titleGenConfig: runtimeConfig.title } : {}),
      ...(runtimeConfig.permissionPolicy !== undefined ? { permissionPolicy: runtimeConfig.permissionPolicy } : {}),
      ...(runtimeConfig.questionPolicy !== undefined ? { questionPolicy: runtimeConfig.questionPolicy } : {}),
      useSessionIdle: runtimeConfig.useSessionIdle,
      vcsSummary: runtimeConfig.vcsSummary,
      ...(runtimeConfig.contextPolicy !== undefined ? { contextPolicy: runtimeConfig.contextPolicy } : {}),
      ...(runtimeConfig.prdDir !== undefined ? { prdDir: runtimeConfig.prdDir } : {}),
      recoverySnapshots: runtimeConfig.recovery.snapshots,
      currentBranch,
    });
    return Number(process.exitCode ?? 0);
  }

  return runTui(options);
}

try {
  process.exitCode = Number(await main());
} catch (error) {
  if (error instanceof AttachedServerAgentError || error instanceof AttachedServerLocationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
