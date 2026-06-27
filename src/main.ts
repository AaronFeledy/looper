#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { BoxRenderable, createCliRenderer, type CliRenderer } from "@opentui/core";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join, resolve } from "node:path";

import { HelpRequested, parseArgs, resolveAttachUrl as resolveConfiguredAttachUrl } from "./lib/args.ts";
import { AttachedServerAgentError } from "./lib/attached-server-agents.ts";
import { type BranchWatcher, watchBranch } from "./lib/branch-watcher.ts";
import { CONFIG_FILE_NAMES, findConfigFile, loadRuntimeConfig, loadSteps } from "./lib/config.ts";
import { startBackgroundAgentStreamer } from "./lib/background-agent-stream.ts";
import { detectGithubRepo } from "./lib/github.ts";
import { type GithubWatcher, watchGithubPr } from "./lib/github-watcher.ts";
import { runNonTty, waitWithCountdown } from "./lib/fallback.ts";
import { runIteration, StepFailureError, type ResumeSession } from "./lib/orchestrator.ts";
import {
  applyManagedOpencodeResources,
  assertManagedOpencodeResourcesLoaded,
  DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS,
  LOOPER_MANAGED_RESOURCES,
} from "./lib/opencode-managed-resources.ts";
import { resumeSessionWorkState, type Step } from "./lib/runner.ts";
import { recoveryResumeForChoice, shouldAutoStartSavedSession } from "./lib/recovery-decisions.ts";
import { startOrAttachServer, type ServerHandle } from "./lib/sdk-server.ts";
import { cancelPendingNotify, createLoopState, createStepRow, dismissEscConfirm, type EscConfirmMode, notify, resetIterationNavigationState, setGithubStatus, snapshotIterationToHistory } from "./lib/state.ts";
import { startHistoryStreamer } from "./lib/history-stream.ts";
import {
  clearStopAfterIterationFile,
  clearResumeStepFile,
  clearRunStateFile,
  clearStopFile,
  initStatePaths,
  readRunState,
  readStopAfterIterationFile,
  readStopFile,
  resumeStepIndex,
  stopAfterIterationFileExists,
  stopFileExists,
  writeResumeStep,
  writeRunState,
  writeStopAfterIterationFile,
  writeStopFile,
} from "./lib/state-files.ts";
import { createAgentStream } from "./tui/agent-stream.ts";
import { createBootScreen, type BootScreen } from "./tui/boot-screen.ts";
import { createFooter } from "./tui/footer.ts";
import { createGithubStatusPanel } from "./tui/github-status.ts";
import { createHeader } from "./tui/header.ts";
import { bindKeys, installBootInterruptHandler } from "./tui/keys.ts";
import { createRecoveryMenu } from "./tui/recovery-menu.ts";
import { createStepList, LIST_WIDTH } from "./tui/step-list.ts";

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
  state.stepOutputLines = steps.map(() => []);
  state.steps = steps.map((step) => createStepRow(step.name));
  resetIterationNavigationState(state);
  notify();
}

async function waitForStart(state: ReturnType<typeof createLoopState>): Promise<void> {
  while (!state.started && !state.quitting && !state.stopAfterIteration) {
    notify();
    await Bun.sleep(100);
  }
}

async function waitForRecoveryChoice(state: ReturnType<typeof createLoopState>): Promise<"restart" | "nudge" | "quit"> {
  while (state.recoveryChoice === null && !state.quitting && !stopFileExists() && !stopAfterIterationFileExists()) {
    notify();
    await Bun.sleep(100);
  }
  return state.recoveryChoice ?? "quit";
}

function clearStopFilesForNewRun(): void {
  clearStopFile();
  clearStopAfterIterationFile();
}

function saveResumeStep(steps: Step[], stepIndex: number): void {
  const step = steps[stepIndex];
  if (step === undefined) {
    clearResumeStepFile();
    return;
  }
  writeResumeStep(stepIndex, step.name);
}

function saveNextResumeStep(steps: Step[], nextIndex: number): void {
  if (nextIndex >= steps.length) {
    clearResumeStepFile();
    return;
  }
  saveResumeStep(steps, nextIndex);
}

function saveRunStatePosition(iteration: number, steps: Step[], stepIndex: number, title?: string): void {
  const step = steps[stepIndex];
  if (step === undefined) return;
  writeRunState({ iteration, stepIndex, stepName: step.name, ...(title !== undefined ? { title } : {}) });
}

function saveRunStateAdvance(iteration: number, steps: Step[], nextIndex: number, title?: string): void {
  if (steps.length === 0) {
    clearRunStateFile();
    return;
  }
  if (nextIndex >= steps.length) {
    // Crossing into a new iteration: the prior iteration's title does not carry.
    writeRunState({ iteration: iteration + 1, stepIndex: 0, stepName: steps[0]!.name });
    return;
  }
  writeRunState({ iteration, stepIndex: nextIndex, stepName: steps[nextIndex]!.name, ...(title !== undefined ? { title } : {}) });
}

function clearRunArtifactsForNewRun(): void {
  clearResumeStepFile();
  clearRunStateFile();
}

function stopReason(): string {
  return readStopFile() ?? readStopAfterIterationFile() ?? "stop requested";
}

function resolveAttachUrl(
  options: ReturnType<typeof parseArgs>,
  runtimeConfig: ReturnType<typeof loadRuntimeConfig>,
): string | undefined {
  return resolveConfiguredAttachUrl(options, runtimeConfig.opencodeServerUrl, opencodeAttachUrl);
}

async function runTui(options: ReturnType<typeof parseArgs>): Promise<number> {
  const steps = loadSteps(configDir);
  if (options.start) clearStopFilesForNewRun();
  if (options.fresh) clearRunArtifactsForNewRun();

  const state = createLoopState({ maxIterations: options.maxIterations, stepNames: steps.map((step) => step.name) });
  state.branch = await currentBranch();
  state.started = options.start;

  // Re-read on-disk checkpoints both at boot and at go: a checkpoint edited
  // while the idle TUI was open must not be ignored (boot values go stale).
  type ResumePlan = {
    startIteration: number;
    firstIterationStartStepIndex: number;
    firstIterationResume: ResumeSession | undefined;
    resumed: boolean;
    firstIterationTitle: string | undefined;
  };
  const computeResumePlan = (planSteps: Step[]): ResumePlan => {
    let planStartIteration = 1;
    let planStartStepIndex = 0;
    let planResume: ResumeSession | undefined;
    let planResumed = false;
    let planTitle: string | undefined;
    if (!options.fresh) {
      const runState = readRunState();
      if (runState !== null) {
        planResumed = true;
        planStartIteration = Math.max(1, runState.iteration);
        const named = planSteps.findIndex((step) => step.name === runState.stepName);
        planStartStepIndex = named !== -1 ? named : Math.max(0, Math.min(planSteps.length - 1, runState.stepIndex));
        planTitle = runState.title;
        if (runState.sessionID !== undefined) {
          planResume = {
            sessionID: runState.sessionID,
            ...(runState.messageID !== undefined ? { messageID: runState.messageID } : {}),
            stepName: runState.stepName,
          };
        }
      } else {
        planStartStepIndex = resumeStepIndex(planSteps);
        planResumed = planStartStepIndex > 0;
      }
    }
    if (planStartIteration > options.maxIterations) {
      planStartIteration = 1;
      planStartStepIndex = 0;
      planResume = undefined;
      planResumed = false;
      planTitle = undefined;
      clearRunArtifactsForNewRun();
    }
    return {
      startIteration: planStartIteration,
      firstIterationStartStepIndex: planStartStepIndex,
      firstIterationResume: planResume,
      resumed: planResumed,
      firstIterationTitle: planTitle,
    };
  };

  let { startIteration, firstIterationStartStepIndex, firstIterationResume, resumed: firstIterationResumed, firstIterationTitle } =
    computeResumePlan(steps);

  const applyResumePlan = (plan: ResumePlan): void => {
    startIteration = plan.startIteration;
    firstIterationStartStepIndex = plan.firstIterationStartStepIndex;
    firstIterationResume = plan.firstIterationResume;
    firstIterationResumed = plan.resumed;
    firstIterationTitle = plan.firstIterationTitle;
  };

  const autoStartIfSavedSessionRunning = async (client: ReturnType<typeof createOpencodeClient>): Promise<void> => {
    if (!shouldAutoStartSavedSession({
      started: state.started,
      fresh: options.fresh,
      stopFilePresent: stopFileExists(),
      stopAfterIterationFilePresent: stopAfterIterationFileExists(),
    })) return;
    const plan = computeResumePlan(loadSteps(configDir));
    const sessionID = plan.firstIterationResume?.sessionID;
    const messageID = plan.firstIterationResume?.messageID;
    if (sessionID === undefined || messageID === undefined) return;
    const workState = await resumeSessionWorkState({ client, repoDir, sessionID, statusTimeoutMs: DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS, signal: bootAbort.signal });
    if (workState !== "running") return;
    applyResumePlan(plan);
    firstIterationWasResumed = plan.resumed;
    firstIterationResumePoint = plan.firstIterationStartStepIndex;
    state.resumable = false;
    clearStopFilesForNewRun();
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
  let recoveryNudgeNext = false;
  let renderer: CliRenderer | undefined;
  let bootScreen: BootScreen | undefined;
  let booting = true;
  const bootAbort = new AbortController();
  let server: ServerHandle | undefined;
  let cleanupBootInterrupt: (() => void) | undefined;
  let cleanupKeys: (() => void) | undefined;
  let backgroundAgentStreamer: { stop: () => void } | undefined;
  let historyStreamer: { stop: () => void } | undefined;
  let branchWatcher: BranchWatcher | null = null;
  let branchSafetyTimer: ReturnType<typeof setInterval> | undefined;
  let githubWatcher: GithubWatcher | undefined;
  let exitReason: string | undefined;

  const finish = (exitCode: number, reason: string): number => {
    exitReason = reason;
    return exitCode;
  };

  const requestQuit = (reason: string) => {
    if (state.quitting) return;
    state.quitting = true;
    exitReason = reason;
    writeStopFile(reason);
    notify();
  };

  const requestStopAfterIteration = (reason: string) => {
    if (state.stopAfterIteration) return;
    state.stopAfterIteration = true;
    exitReason = reason;
    writeStopAfterIterationFile(reason);
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
    branchWatcher = await watchBranch({
      repoDir,
      onChange: (branch) => {
        if (state.branch === branch) return;
        state.branch = branch;
        notify();
        // A new branch usually means a different (or absent) PR; re-query now
        // rather than waiting up to the 15s poll.
        githubWatcher?.refresh();
      },
    });
    throwIfBootAborted();

    // Belt-and-braces fallback around the 5s background poll: re-check HEAD
    // every 60s in case the interval timer is starved or the watcher is
    // degraded. Cheap (one stat + tiny read).
    if (branchWatcher !== null) {
      branchSafetyTimer = setInterval(() => branchWatcher?.refresh(), 60_000);
      branchSafetyTimer.unref?.();
    }

    bootScreen.begin("Loading configuration");
    const runtimeConfig = loadRuntimeConfig(configDir);
    const attachUrl = resolveAttachUrl(options, runtimeConfig);

    bootScreen.begin(attachUrl !== undefined ? `Attaching to opencode (${attachUrl})` : "Starting opencode server");
    server = await startOrAttachServer({ opencodeBin, attachUrl, signal: bootAbort.signal });
    throwIfBootAborted();

    bootScreen.begin("Connecting client");
    const client = createOpencodeClient({ baseUrl: server.url });
    if (attachUrl !== undefined) {
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

    const leftColumn = new BoxRenderable(renderer, {
      id: "looper-left",
      width: LIST_WIDTH,
      height: "100%",
      flexDirection: "column",
    });
    leftColumn.add(stepList);
    bootScreen.begin("Detecting GitHub repository");
    const githubEnabled = await detectGithubRepo(repoDir);
    throwIfBootAborted();
    if (githubEnabled) {
      leftColumn.add(createGithubStatusPanel(renderer, state));
      githubWatcher = watchGithubPr({
        repoDir,
        getBranch: () => state.branch,
        onUpdate: (status) => setGithubStatus(state, status),
      });
    }
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
      clearRunArtifactsForNewRun();
      startIteration = 1;
      firstIterationStartStepIndex = 0;
      firstIterationResume = undefined;
      firstIterationResumed = false;
      firstIterationWasResumed = false;
      firstIterationResumePoint = 0;
      firstIterationTitle = undefined;
      const freshSteps = loadSteps(configDir);
      state.steps = freshSteps.map((step) => createStepRow(step.name));
      state.stepOutputLines = freshSteps.map(() => []);
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
      clearStopFilesForNewRun();
      if (options.fresh) clearRunArtifactsForNewRun();
      if (!state.started) {
        if (state.manualStepSelection && state.selectedStepIndex !== null) {
          firstIterationStartStepIndex = state.selectedStepIndex;
          firstIterationResume = undefined;
          // If the idle boot was a checkpoint resume and the user selected at/after
          // that checkpoint, the prefix steps were done in a prior process → pass
          // resumedPriorSteps so they render "done", not "skipped".
          firstIterationResumed = firstIterationWasResumed && (state.selectedStepIndex >= firstIterationResumePoint);
          // Clear the title only if selecting before the checkpoint; keep it if
          // resuming at/after the checkpoint so inherited-title steps still apply it.
          if (!firstIterationResumed) {
            firstIterationTitle = undefined;
          }
        } else {
          ({ startIteration, firstIterationStartStepIndex, firstIterationResume, resumed: firstIterationResumed, firstIterationTitle } =
            computeResumePlan(loadSteps(configDir)));
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

    for (let iteration = startIteration; iteration <= options.maxIterations; iteration += 1) {
      if (stopFileExists() || stopAfterIterationFileExists()) return finish(0, stopReason());

      const iterationSteps = loadSteps(configDir);
      resetIterationState(state, iteration, state.branch || (await currentBranch()), iterationSteps);
      const startedAt = Date.now();
      const resumeForThisIteration = iteration === startIteration ? firstIterationResume : undefined;
      const recoveryNudgeForThisIteration = recoveryNudgeNext;
      recoveryNudgeNext = false;
      let result: Awaited<ReturnType<typeof runIteration>>;
      try {
        result = await runIteration({
          state,
          iteration,
          client,
          repoDir,
          configDir,
          startStepIndex: iteration === startIteration ? firstIterationStartStepIndex : 0,
          ...(iteration === startIteration && firstIterationResumed ? { resumedPriorSteps: true } : {}),
          ...(iteration === startIteration && firstIterationTitle !== undefined ? { initialWorkDescription: firstIterationTitle } : {}),
          ...(resumeForThisIteration !== undefined ? { resume: resumeForThisIteration } : {}),
          ...(recoveryNudgeForThisIteration ? { recoveryNudge: true } : {}),
          ...(runtimeConfig.title !== undefined ? { titleGenConfig: runtimeConfig.title } : {}),
          hooks: {
            onStepBegin: ({ index, iteration: stepIteration, title }) => {
              saveResumeStep(loadSteps(configDir), index);
              saveRunStatePosition(stepIteration, loadSteps(configDir), index, title);
              // Step boundaries are common branch-change moments (the previous
              // step may have run `git checkout`); re-read HEAD immediately so
              // the header doesn't lag up to 5s behind reality.
              branchWatcher?.refresh();
              githubWatcher?.refresh();
            },
            onStepSession: ({ iteration: stepIteration, index, stepName, sessionID, messageID, title }) => {
              writeRunState({ iteration: stepIteration, stepIndex: index, stepName, sessionID, messageID, ...(title !== undefined ? { title } : {}) });
            },
            onStepFinish: ({ nextIndex, status, iteration: stepIteration, title }) => {
              if (status === "done") {
                saveNextResumeStep(loadSteps(configDir), nextIndex);
                saveRunStateAdvance(stepIteration, loadSteps(configDir), nextIndex, title);
              }
              branchWatcher?.refresh();
              githubWatcher?.refresh();
            },
          },
        });
      } catch (error) {
        if (!(error instanceof StepFailureError)) throw error;
        state.started = false;
        state.paused = false;
        state.recovery = {
          stepName: error.stepName ?? "step",
          reason: error.message,
          ...(error.sessionID !== undefined ? { sessionID: error.sessionID } : {}),
        };
        state.recoveryChoice = null;
        notify();
        const choice = await waitForRecoveryChoice(state);
        state.recovery = null;
        state.recoveryChoice = null;
        notify();
        if (choice === "quit" || state.quitting || state.stopAfterIteration || stopFileExists() || stopAfterIterationFileExists()) {
          return finish(1, exitReason ?? error.message);
        }
        recoveryNudgeNext = choice === "nudge";
        const recoveryRunState = readRunState();
        const recoveryResume = recoveryResumeForChoice({ choice, failedSessionID: error.sessionID, failedStepName: error.stepName, runState: recoveryRunState });
        // Retry the failed step in the SAME iteration. `continue` still runs the
        // loop's `iteration += 1`, so we pin `startIteration` to this iteration
        // and pre-decrement to cancel that increment; otherwise a single-iteration
        // run exits ("max iterations reached") and a multi-iteration run jumps to
        // the next iteration from step 0.
        const failedStepIndex = resumeStepIndex(loadSteps(configDir));
        startIteration = iteration;
        firstIterationStartStepIndex = failedStepIndex;
        firstIterationResumed = failedStepIndex > 0;
        firstIterationResume = recoveryResume;
        // Preserve any title generated earlier in this iteration so the
        // recovered step keeps applying it (the failed step's run-state write
        // carries it for inherited-title steps).
        firstIterationTitle = recoveryRunState?.title;
        disarmEscConfirm();
        clearStopFilesForNewRun();
        state.resumable = false;
        state.started = true;
        state.paused = false;
        state.stopAfterIteration = false;
        state.quitting = false;
        notify();
        iteration -= 1;
        continue;
      }

      if (result === "stopped" || state.quitting || state.stopAfterIteration || stopFileExists() || stopAfterIterationFileExists()) {
        return finish(0, exitReason ?? stopReason());
      }

      if (options.waitProvided) {
        const elapsed = elapsedSeconds(startedAt);
        const waitSeconds = options.waitDuration === "execution-time" ? elapsed : options.waitDuration * 60;
        await waitWithCountdown(state, waitSeconds, `Waiting ${waitSeconds}s`, true);
      }
    }

    clearRunArtifactsForNewRun();
    return finish(1, `max iterations reached (${options.maxIterations})`);
  } catch (error) {
    if (bootAbort.signal.aborted) return finish(130, exitReason ?? "looper startup interrupted");
    throw error;
  } finally {
    cleanupBootInterrupt?.();
    cleanupKeys?.();
    backgroundAgentStreamer?.stop();
    historyStreamer?.stop();
    githubWatcher?.stop();
    if (branchSafetyTimer !== undefined) clearInterval(branchSafetyTimer);
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
  initStatePaths({ configDir });
  ensureConfigDir();
  ensureConfigExists();
  applyManagedOpencodeResources({ resources: LOOPER_MANAGED_RESOURCES, log: (line) => process.stderr.write(`${line}\n`) });

  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTty) {
    if (!options.start) {
      process.stdout.write("Looper not started. Re-run with --start in non-TTY mode, or use the TUI and press [g]o.\n");
      return 0;
    }

    const runtimeConfig = loadRuntimeConfig(configDir);
    await runNonTty({
      options,
      repoDir,
      configDir,
      opencodeBin,
      attachUrl: resolveAttachUrl(options, runtimeConfig),
      ...(runtimeConfig.title !== undefined ? { titleGenConfig: runtimeConfig.title } : {}),
      currentBranch,
    });
    return Number(process.exitCode ?? 0);
  }

  return runTui(options);
}

try {
  process.exitCode = Number(await main());
} catch (error) {
  if (error instanceof AttachedServerAgentError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
