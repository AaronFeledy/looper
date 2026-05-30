#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { BoxRenderable, createCliRenderer, type CliRenderer } from "@opentui/core";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { join, resolve } from "node:path";

import { HelpRequested, parseArgs, resolveAttachUrl as resolveConfiguredAttachUrl } from "./lib/args.ts";
import { type BranchWatcher, watchBranch } from "./lib/branch-watcher.ts";
import { CONFIG_FILE_NAME, configFilePath, loadRuntimeConfig, loadSteps } from "./lib/config.ts";
import { startBackgroundAgentStreamer } from "./lib/background-agent-stream.ts";
import { detectGithubRepo } from "./lib/github.ts";
import { type GithubWatcher, watchGithubPr } from "./lib/github-watcher.ts";
import { runNonTty, waitWithCountdown } from "./lib/fallback.ts";
import { runIteration, StepFailureError } from "./lib/orchestrator.ts";
import type { Step } from "./lib/runner.ts";
import { startOrAttachServer, type ServerHandle } from "./lib/sdk-server.ts";
import { createLoopState, notify, resetIterationNavigationState, setGithubStatus } from "./lib/state.ts";
import {
  clearStopAfterIterationFile,
  clearResumeStepFile,
  clearStopFile,
  initStatePaths,
  readStopAfterIterationFile,
  readStopFile,
  resumeStepIndex,
  stopAfterIterationFileExists,
  stopFileExists,
  writeResumeStep,
  writeStopAfterIterationFile,
  writeStopFile,
} from "./lib/state-files.ts";
import { createAgentStream } from "./tui/agent-stream.ts";
import { createFooter } from "./tui/footer.ts";
import { createGithubStatusPanel } from "./tui/github-status.ts";
import { createHeader } from "./tui/header.ts";
import { bindKeys } from "./tui/keys.ts";
import { createStepList, LIST_WIDTH } from "./tui/step-list.ts";

const repoDir = process.env.LOOPER_REPO_DIR ? resolve(process.env.LOOPER_REPO_DIR) : process.cwd();
const configDir = process.env.LOOPER_CONFIG_DIR ? resolve(process.env.LOOPER_CONFIG_DIR) : join(repoDir, ".local", "looper");
const opencodeAttachUrl = process.env.OPENCODE_ATTACH_URL ?? "http://127.0.0.1:4096";
const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";

initStatePaths({ configDir });

function ensureConfigDir(): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}

function ensureConfigExists(): void {
  const path = configFilePath(configDir);
  if (existsSync(path)) return;
  process.stderr.write(`error: missing ${CONFIG_FILE_NAME} at ${path}\n`);
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
  state.steps = steps.map((step) => ({ name: step.name, status: "pending" as const, outputLines: [], outputLineTimes: [], outputScrollTop: 0, outputPinnedToBottom: true, backgroundAgents: [] }));
  resetIterationNavigationState(state);
  notify();
}

async function waitForStart(state: ReturnType<typeof createLoopState>): Promise<void> {
  while (!state.started && !state.quitting && !state.stopAfterIteration) {
    notify();
    await Bun.sleep(100);
  }
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

function stopReason(): string {
  return readStopFile() ?? readStopAfterIterationFile() ?? "stop requested";
}

function resolveAttachUrl(options: ReturnType<typeof parseArgs>): string | undefined {
  const runtimeConfig = loadRuntimeConfig(configDir);
  return resolveConfiguredAttachUrl(options, runtimeConfig.opencodeServerUrl, opencodeAttachUrl);
}

async function runTui(options: ReturnType<typeof parseArgs>): Promise<number> {
  const steps = loadSteps(configDir);
  if (options.start) clearStopFilesForNewRun();
  if (options.start && !options.continueFromLastStep) clearResumeStepFile();

  const state = createLoopState({ maxIterations: options.maxIterations, stepNames: steps.map((step) => step.name) });
  state.branch = await currentBranch();
  state.started = options.start;

  let firstIterationStartStepIndex = options.continueFromLastStep ? resumeStepIndex(steps) : 0;
  let resumeAfterStepFailure = false;
  let renderer: CliRenderer | undefined;
  let server: ServerHandle | undefined;
  let cleanupKeys: (() => void) | undefined;
  let backgroundAgentStreamer: { stop: () => void } | undefined;
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

  const handleSigint = () => {
    requestStopAfterIteration("SIGINT received by looper TUI");
  };

  const handleSigterm = () => {
    requestQuit("SIGTERM received by looper TUI");
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

    // Belt-and-braces fallback around the 5s background poll: re-check HEAD
    // every 60s in case the interval timer is starved or the watcher is
    // degraded. Cheap (one stat + tiny read).
    if (branchWatcher !== null) {
      branchSafetyTimer = setInterval(() => branchWatcher?.refresh(), 60_000);
      branchSafetyTimer.unref?.();
    }

    const attachUrl = resolveAttachUrl(options);
    server = await startOrAttachServer({ opencodeBin, attachUrl });
    const client = createOpencodeClient({ baseUrl: server.url });

    backgroundAgentStreamer = startBackgroundAgentStreamer({ state, client, repoDir });

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

    const githubEnabled = await detectGithubRepo(repoDir);
    if (githubEnabled) {
      leftColumn.add(createGithubStatusPanel(renderer, state));
      githubWatcher = watchGithubPr({
        repoDir,
        getBranch: () => state.branch,
        onUpdate: (status) => setGithubStatus(state, status),
      });
    }

    root.add(createHeader(renderer, state));
    body.add(leftColumn);
    body.add(stream);
    root.add(body);
    root.add(createFooter(renderer, state));
    renderer.root.add(root);

    cleanupKeys = bindKeys(renderer, state, {
      onQuit: () => {
        requestQuit("quit requested from looper TUI");
      },
      onInterrupt: () => {
        requestStopAfterIteration("Ctrl-C received by looper TUI");
      },
      onSkip: () => {
        if (state.activeStepIndex === null) return;
        state.skipRequested = true;
        notify();
      },
      onStart: () => {
        clearStopFilesForNewRun();
        if (!options.continueFromLastStep && !resumeAfterStepFailure) clearResumeStepFile();
        if (!state.started) {
          if (resumeAfterStepFailure) {
            firstIterationStartStepIndex = resumeStepIndex(loadSteps(configDir));
            resumeAfterStepFailure = false;
          } else if (state.manualStepSelection && state.selectedStepIndex !== null) {
            firstIterationStartStepIndex = state.selectedStepIndex;
          } else if (options.continueFromLastStep) {
            firstIterationStartStepIndex = resumeStepIndex(loadSteps(configDir));
          }
        }
        state.started = true;
        state.stopAfterIteration = false;
        state.quitting = false;
        notify();
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

    await waitForStart(state);

    for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
      if (stopFileExists() || stopAfterIterationFileExists()) return finish(0, stopReason());

      const iterationSteps = loadSteps(configDir);
      resetIterationState(state, iteration, state.branch || (await currentBranch()), iterationSteps);
      const startedAt = Date.now();
      let result: Awaited<ReturnType<typeof runIteration>>;
      try {
        result = await runIteration({
          state,
          iteration,
          client,
          repoDir,
          configDir,
          startStepIndex: iteration === 1 ? firstIterationStartStepIndex : 0,
          hooks: {
            onStepBegin: ({ index }) => {
              saveResumeStep(loadSteps(configDir), index);
              // Step boundaries are common branch-change moments (the previous
              // step may have run `git checkout`); re-read HEAD immediately so
              // the header doesn't lag up to 5s behind reality.
              branchWatcher?.refresh();
              githubWatcher?.refresh();
            },
            onStepFinish: ({ nextIndex, status }) => {
              if (status === "done") saveNextResumeStep(loadSteps(configDir), nextIndex);
              branchWatcher?.refresh();
              githubWatcher?.refresh();
            },
          },
        });
      } catch (error) {
        if (!(error instanceof StepFailureError)) throw error;
        state.started = false;
        state.paused = false;
        notify();
        await waitForStart(state);
        if (state.quitting || state.stopAfterIteration || stopFileExists() || stopAfterIterationFileExists()) {
          return finish(1, exitReason ?? error.message);
        }
        resumeAfterStepFailure = true;
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

    return finish(1, `max iterations reached (${options.maxIterations})`);
  } finally {
    cleanupKeys?.();
    backgroundAgentStreamer?.stop();
    githubWatcher?.stop();
    if (branchSafetyTimer !== undefined) clearInterval(branchSafetyTimer);
    branchWatcher?.stop();
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
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

  ensureConfigDir();
  ensureConfigExists();

  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTty) {
    if (!options.start) {
      process.stdout.write("Looper not started. Re-run with --start in non-TTY mode, or use the TUI and press [g]o.\n");
      return 0;
    }

    await runNonTty({
      options,
      repoDir,
      configDir,
      opencodeBin,
      attachUrl: resolveAttachUrl(options),
      currentBranch,
    });
    return Number(process.exitCode ?? 0);
  }

  return runTui(options);
}

try {
  process.exitCode = Number(await main());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
}
