import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import type { Options } from "./args.ts";
import { loadSteps } from "./config.ts";
import { runIteration } from "./orchestrator.ts";
import { startOrAttachServer } from "./sdk-server.ts";
import { createLoopState, notify, subscribe, type LoopState } from "./state.ts";
import {
  clearResumeStepFile,
  clearStopAfterIterationFile,
  clearStopFile,
  resumeStepIndex,
  stopAfterIterationFileExists,
  stopFileExists,
  writeResumeStep,
} from "./state-files.ts";
import type { Step } from "./runner.ts";

export type FallbackOptions = {
  options: Options;
  repoDir: string;
  configDir: string;
  opencodeBin: string;
  attachUrl?: string;
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
  currentBranch,
}: FallbackOptions): Promise<void> {
  clearStopFile();
  clearStopAfterIterationFile();
  if (!options.continueFromLastStep) clearResumeStepFile();

  process.stdout.write(divider("Looper · OpenCode step runner", ui.magenta));
  process.stdout.write(`${label("Mode", "non-TTY fallback")}\n`);
  process.stdout.write(`${label("Branch", await currentBranch())}\n`);
  process.stdout.write(`${label("Config", configDir)}\n`);
  process.stdout.write(`${label("Steps", "reload from looper.yaml before each step")}\n`);
  process.stdout.write(`${ui.dim("│ edit looper.yaml while running to add, remove, or reorder steps")}\n`);

  const server = await startOrAttachServer({ opencodeBin, attachUrl });
  const client = createOpencodeClient({ baseUrl: server.url });

  try {
    await runNonTtyIterations({ options, repoDir, configDir, client, currentBranch });
  } finally {
    await server.close();
  }
}

async function runNonTtyIterations({
  options,
  repoDir,
  configDir,
  client,
  currentBranch,
}: {
  options: Options;
  repoDir: string;
  configDir: string;
  client: ReturnType<typeof createOpencodeClient>;
  currentBranch: () => Promise<string>;
}): Promise<void> {
  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    if (stopFileExists()) {
      process.stdout.write(`\n${ui.yellow("■ stop file exists")} stopping before iteration ${iteration}\n`);
      return;
    }

    const stepsSnapshot = loadSteps(configDir);
    const startStepIndex = iteration === 1 && options.continueFromLastStep ? resumeStepIndex(stepsSnapshot) : 0;
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
      hooks: {
        onStepBegin: ({ step, index, totalSteps }) => {
          saveResumeStep(loadSteps(configDir), index);
          process.stdout.write(`\n${divider(`Step ${index + 1}/${totalSteps} · ${step.name}`, ui.green)}`);
          process.stdout.write(`${label("Agent", step.agent)}\n`);
          process.stdout.write(`${label("Model", step.model || "agent default")}\n`);
          process.stdout.write(`${label("Variant", step.variant || "agent default")}\n`);
          process.stdout.write(`${label("Prompt", step.prompt)}\n`);
        },
        onStepFinish: ({ nextIndex, status }) => {
          if (status === "done") saveNextResumeStep(loadSteps(configDir), nextIndex);
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

  process.stdout.write(`\n${ui.yellow("■ max iterations reached")} ${options.maxIterations}; no .looper-stop found\n`);
  process.exitCode = 1;
}
