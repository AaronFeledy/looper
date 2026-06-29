import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import type { Options } from "./args.ts";
import { loadSteps, type PermissionPolicy, type QuestionPolicy, type RecoverySnapshotsConfig, type TitleGenConfig } from "./config.ts";
import { runIteration } from "./orchestrator.ts";
import { startOrAttachServer } from "./sdk-server.ts";
import { assertManagedOpencodeResourcesLoaded, LOOPER_MANAGED_RESOURCES } from "./opencode-managed-resources.ts";
import { assertAttachedServerLocation, assertConfiguredResourcesExist } from "./attached-server-agents.ts";
import { createLoopState, notify, subscribe, type LoopState } from "./state.ts";
import {
  clearResumeStepFile,
  clearRunStateFile,
  clearStopAfterIterationFile,
  clearStopFile,
  readRunState,
  resumeStepIndex,
  stopAfterIterationFileExists,
  stopFileExists,
  writeResumeStep,
  writeRunState,
} from "./state-files.ts";
import type { ResumeSession } from "./orchestrator.ts";
import type { Step } from "./runner.ts";
import { createLooperRunID } from "./session-metadata.ts";

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
  vcsSummary?: boolean;
  currentBranch: () => Promise<string>;
};

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function resumeTime(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toLocaleTimeString();
}

function sectionTimestamp(): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date())
    .toLowerCase();
}

function terminalWidth(): number {
  return Math.max(40, process.stdout.columns ?? 80);
}

function color(code: string, text: string): string {
  if (process.env.NO_COLOR || (!process.stdout.isTTY && !process.stderr.isTTY)) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

const ui = {
  dim: (text: string) => color("2", text),
  cyan: (text: string) => color("36", text),
  green: (text: string) => color("32", text),
  yellow: (text: string) => color("33", text),
  magenta: (text: string) => color("35", text),
  bold: (text: string) => color("1", text),
};

function label(name: string, value: string): string {
  return `${ui.dim(name.padEnd(14, " "))} ${value}`;
}

function divider(title: string, colorize: (text: string) => string = ui.cyan): string {
  const prefix = `╭─ ${title} `;
  const timestamp = sectionTimestamp();
  const dashes = "─".repeat(Math.max(1, terminalWidth() - prefix.length - timestamp.length - 1));
  return `${colorize(prefix)}${ui.dim(dashes)} ${ui.dim(timestamp)}\n`;
}

function configuredStepAgents(steps: readonly Step[]): string[] {
  const agents = new Set<string>();
  for (const step of steps) {
    if (step.agent !== undefined && step.agent.length > 0) agents.add(step.agent);
  }
  return [...agents];
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

function saveRunStatePosition(iteration: number, steps: Step[], stepIndex: number, looperRunID?: string): void {
  const step = steps[stepIndex];
  if (step === undefined) return;
  writeRunState({ iteration, stepIndex, stepName: step.name, ...(looperRunID !== undefined ? { looperRunID } : {}) });
}

function saveRunStateAdvance(iteration: number, steps: Step[], nextIndex: number, looperRunID?: string): void {
  if (steps.length === 0) {
    clearRunStateFile();
    return;
  }
  if (nextIndex >= steps.length) {
    writeRunState({ iteration: iteration + 1, stepIndex: 0, stepName: steps[0]!.name, ...(looperRunID !== undefined ? { looperRunID } : {}) });
    return;
  }
  writeRunState({ iteration, stepIndex: nextIndex, stepName: steps[nextIndex]!.name, ...(looperRunID !== undefined ? { looperRunID } : {}) });
}

export async function waitWithCountdown(
  state: LoopState,
  seconds: number,
  label: string,
  isTty = false,
): Promise<void> {
  const startedAt = Date.now();
  while (elapsedSeconds(startedAt) < seconds && !state.quitting && !stopFileExists()) {
    if (!isTty) {
      const remaining = Math.max(0, seconds - elapsedSeconds(startedAt));
      process.stderr.write(
        `${ui.yellow("⏳ waiting")} ${remaining}s ${ui.dim("·")} ${label} ${ui.dim("· resumes")} ${resumeTime(remaining)}\n`,
      );
    }
    notify();
    await Bun.sleep(isTty ? 250 : Math.min(15, Math.max(1, seconds)) * 1000);
  }
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
  vcsSummary,
  currentBranch,
}: FallbackOptions): Promise<void> {
  clearStopFile();
  clearStopAfterIterationFile();
  if (options.fresh) {
    clearResumeStepFile();
    clearRunStateFile();
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
      ...(vcsSummary !== undefined ? { vcsSummary } : {}),
      currentBranch,
    });
  } finally {
    await server.close();
  }
}

async function runNonTtyIterations({
  options,
  repoDir,
  configDir,
  client,
  titleGenConfig,
  recoverySnapshots,
  permissionPolicy,
  questionPolicy,
  useSessionIdle,
  vcsSummary,
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
  vcsSummary?: boolean;
  currentBranch: () => Promise<string>;
}): Promise<void> {
  let startIteration = 1;
  let firstStartStepIndex = 0;
  let firstIterationResume: ResumeSession | undefined;
  let looperRunID = readRunState()?.looperRunID ?? createLooperRunID();
  if (!options.fresh) {
    const runState = readRunState();
    if (runState !== null) {
      startIteration = Math.max(1, runState.iteration);
      const steps0 = loadSteps(configDir);
      const named = steps0.findIndex((step) => step.name === runState.stepName);
      firstStartStepIndex = named !== -1 ? named : Math.max(0, Math.min(steps0.length - 1, runState.stepIndex));
      if (runState.sessionID !== undefined) {
        firstIterationResume = {
          sessionID: runState.sessionID,
          ...(runState.messageID !== undefined ? { messageID: runState.messageID } : {}),
          stepName: runState.stepName,
        };
      }
    } else {
      firstStartStepIndex = resumeStepIndex(loadSteps(configDir));
    }
  }
  if (startIteration > options.maxIterations) {
    startIteration = 1;
    firstStartStepIndex = 0;
    firstIterationResume = undefined;
    clearResumeStepFile();
    clearRunStateFile();
    looperRunID = createLooperRunID();
  }

  for (let iteration = startIteration; iteration <= options.maxIterations; iteration += 1) {
    if (stopFileExists()) {
      process.stdout.write(`\n${ui.yellow("■ stop file exists")} stopping before iteration ${iteration}\n`);
      return;
    }

    const stepsSnapshot = loadSteps(configDir);
    const startStepIndex = iteration === startIteration ? firstStartStepIndex : 0;
    const resumeForThisIteration = iteration === startIteration ? firstIterationResume : undefined;
    const state = createLoopState({
      maxIterations: options.maxIterations,
      stepNames: stepsSnapshot.map((step) => step.name),
    });
    state.iteration = iteration;
    state.branch = await currentBranch();
    state.iterationStartedAt = Date.now();

    let printedLineCount = 0;
    const unsubscribe = subscribe(() => {
      for (const line of state.agentLines.slice(printedLineCount)) process.stdout.write(`${line}\n`);
      printedLineCount = state.agentLines.length;
    });

    process.stdout.write(`\n${divider(`Iteration ${iteration}/${options.maxIterations}`, ui.cyan)}`);
    process.stdout.write(`${label("Branch", state.branch)}\n`);
    process.stdout.write(`${label("Step count", `${stepsSnapshot.length} at iteration start`)}\n`);
    if (startStepIndex > 0) process.stdout.write(`${label("Continuing", `from step ${startStepIndex + 1}/${stepsSnapshot.length}`)}\n`);
    process.stdout.write(`${ui.dim("│ list may change mid-iteration when looper.yaml changes")}\n`);

    const startedAt = Date.now();
    const result = await runIteration({
      state,
      iteration,
      client,
      repoDir,
      configDir,
      startStepIndex,
      ...(resumeForThisIteration !== undefined ? { resume: resumeForThisIteration } : {}),
      ...(titleGenConfig !== undefined ? { titleGenConfig } : {}),
      ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
      ...(questionPolicy !== undefined ? { questionPolicy } : {}),
      ...(useSessionIdle !== undefined ? { useSessionIdle } : {}),
      ...(vcsSummary !== undefined ? { vcsSummary } : {}),
      looperRunID,
      recoverySnapshots,
      hooks: {
        onStepBegin: ({ step, index, totalSteps, iteration: stepIteration }) => {
          saveResumeStep(loadSteps(configDir), index);
          saveRunStatePosition(stepIteration, loadSteps(configDir), index, looperRunID);
          process.stdout.write(`\n${divider(`Step ${index + 1}/${totalSteps} · ${step.name}`, ui.green)}`);
          process.stdout.write(`${label("Agent", step.agent || "default")}\n`);
          process.stdout.write(`${label("Model", step.model || "default")}\n`);
          process.stdout.write(`${label("Variant", step.variant || "default")}\n`);
          process.stdout.write(`${label("Prompt", step.prompt)}\n`);
        },
        onStepSession: ({ iteration: stepIteration, index, stepName, sessionID, messageID }) => {
          writeRunState({ iteration: stepIteration, stepIndex: index, stepName, sessionID, messageID, looperRunID });
        },
        onStepFinish: ({ nextIndex, status, iteration: stepIteration }) => {
          if (status === "done") {
            saveNextResumeStep(loadSteps(configDir), nextIndex);
            saveRunStateAdvance(stepIteration, loadSteps(configDir), nextIndex, looperRunID);
          }
        },
      },
    });
    unsubscribe();

    if (result === "stopped" || stopFileExists() || stopAfterIterationFileExists()) {
      process.stdout.write(`\n${ui.yellow("■ stop requested")} stopping after iteration ${iteration}\n`);
      return;
    }

    const elapsed = elapsedSeconds(startedAt);
    process.stdout.write(
      `\n${ui.green("✓ iteration complete")} ${iteration}/${options.maxIterations} ${ui.dim("· branch")} ${await currentBranch()} ${ui.dim("·")} ${elapsed}s ${ui.dim("· continuing")}\n`,
    );

    if (options.waitProvided) {
      const waitSeconds = options.waitDuration === "execution-time" ? elapsed : options.waitDuration * 60;
      await waitWithCountdown(state, waitSeconds, `Waiting ${waitSeconds}s`, false);
    }
  }

  clearResumeStepFile();
  clearRunStateFile();
  process.stdout.write(`\n${ui.yellow("■ max iterations reached")} ${options.maxIterations}; no .looper-stop found\n`);
  process.exitCode = 1;
}
