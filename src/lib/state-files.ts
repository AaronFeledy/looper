import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function logStateDiagnostic(message: string): void {
  if (process.env.LOOPER_DEBUG_EVENTS === "1") console.error(`[looper] state-files: ${message}`);
}

function tolerantRm(path: string): void {
  try {
    rmSync(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

function tolerantRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

function writeFileAtomically(path: string, content: string): void {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, content);
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

let configDir: string | undefined;

export function initStatePaths(opts: { configDir: string }): void {
  configDir = opts.configDir;
}

function requireConfigDir(): string {
  if (configDir === undefined) {
    throw new Error("looper state paths not initialized; call initStatePaths({ configDir }) first");
  }
  return configDir;
}

const STOP_FILE_NAME = ".looper-stop";
const STOP_AFTER_ITERATION_FILE_NAME = ".looper-stop-after-iteration";
const RESUME_STEP_FILE_NAME = ".looper-resume-step.json";
const RUN_STATE_FILE_NAME = ".looper-run.json";
const LAST_BRANCH_FILE_NAME = ".last-branch";

function stopFilePath(): string {
  return join(requireConfigDir(), STOP_FILE_NAME);
}

function stopAfterIterationFilePath(): string {
  return join(requireConfigDir(), STOP_AFTER_ITERATION_FILE_NAME);
}

function resumeStepFilePath(): string {
  return join(requireConfigDir(), RESUME_STEP_FILE_NAME);
}

function runStateFilePath(): string {
  return join(requireConfigDir(), RUN_STATE_FILE_NAME);
}

function lastBranchFilePath(): string {
  return join(requireConfigDir(), LAST_BRANCH_FILE_NAME);
}

export type ResumeStep = {
  stepIndex: number;
  stepName: string;
  updatedAt: string;
};

type NamedStep = {
  name: string;
};

export function clearStopFile() {
  tolerantRm(stopFilePath());
}

export function clearStopAfterIterationFile() {
  tolerantRm(stopAfterIterationFilePath());
}

export function clearResumeStepFile() {
  tolerantRm(resumeStepFilePath());
}

function regularFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

export function stopFileExists() {
  return regularFileExists(stopFilePath());
}

export function stopAfterIterationFileExists() {
  return regularFileExists(stopAfterIterationFilePath());
}

function readReasonFile(path: string) {
  const content = tolerantRead(path);
  if (content === null) return null;
  const reason = content.trim();
  return reason.length > 0 ? reason : null;
}

export function readStopFile() {
  return readReasonFile(stopFilePath());
}

export function readStopAfterIterationFile() {
  return readReasonFile(stopAfterIterationFilePath());
}

export function writeStopFile(reason: string) {
  writeFileAtomically(stopFilePath(), `${reason}\n`);
}

export function writeStopAfterIterationFile(reason: string) {
  writeFileAtomically(stopAfterIterationFilePath(), `${reason}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResumeStep(value: unknown): ResumeStep | null {
  if (!isRecord(value)) return null;
  const stepIndex = value.stepIndex;
  const stepName = value.stepName;
  const updatedAt = value.updatedAt;
  if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex) || stepIndex < 0) return null;
  if (typeof stepName !== "string" || stepName.length === 0) return null;
  if (typeof updatedAt !== "string" || updatedAt.length === 0) return null;
  return { stepIndex, stepName, updatedAt };
}

export function readResumeStep(): ResumeStep | null {
  try {
    const content = tolerantRead(resumeStepFilePath());
    if (content === null) return null;
    return parseResumeStep(JSON.parse(content));
  } catch (error) {
    logStateDiagnostic(`ignoring unreadable resume-step file: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function writeResumeStep(stepIndex: number, stepName: string) {
  const record: ResumeStep = { stepIndex, stepName, updatedAt: new Date().toISOString() };
  writeFileAtomically(resumeStepFilePath(), `${JSON.stringify(record, null, 2)}\n`);
}

export function resumeStepIndex(steps: NamedStep[]): number {
  if (steps.length === 0) return 0;
  const resume = readResumeStep();
  if (resume === null) return 0;
  const namedIndex = steps.findIndex((step) => step.name === resume.stepName);
  if (namedIndex !== -1) return namedIndex;
  return Math.max(0, Math.min(steps.length - 1, resume.stepIndex));
}

/**
 * Durable, iteration-aware run pointer (`.looper-run.json`). Superset of
 * {@link ResumeStep}: also records the iteration the loop is on and, while a
 * step is in flight, the opencode `sessionID`/`messageID` so a resume
 * after a crash/exit can reattach to a still-live generation (or restart it).
 *
 * `sessionID`/`messageID` are only present for an IN-PROGRESS step; once a step
 * finishes the pointer is advanced to the next step (or next iteration) WITHOUT
 * session fields, so resume never reattaches to an already-completed step.
 */
export type RunState = {
  iteration: number;
  stepIndex: number;
  stepName: string;
  sessionID?: string;
  messageID?: string;
  updatedAt: string;
};

export type RunStateInput = {
  iteration: number;
  stepIndex: number;
  stepName: string;
  sessionID?: string;
  messageID?: string;
};

function parseRunState(value: unknown): RunState | null {
  if (!isRecord(value)) return null;
  const iteration = value.iteration;
  const stepIndex = value.stepIndex;
  const stepName = value.stepName;
  const updatedAt = value.updatedAt;
  if (typeof iteration !== "number" || !Number.isInteger(iteration) || iteration < 1) return null;
  if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex) || stepIndex < 0) return null;
  if (typeof stepName !== "string" || stepName.length === 0) return null;
  if (typeof updatedAt !== "string" || updatedAt.length === 0) return null;
  const sessionID = typeof value.sessionID === "string" && value.sessionID.length > 0 ? value.sessionID : undefined;
  const messageID = typeof value.messageID === "string" && value.messageID.length > 0 ? value.messageID : undefined;
  return {
    iteration,
    stepIndex,
    stepName,
    ...(sessionID !== undefined ? { sessionID } : {}),
    ...(messageID !== undefined ? { messageID } : {}),
    updatedAt,
  };
}

export function readRunState(): RunState | null {
  try {
    const content = tolerantRead(runStateFilePath());
    if (content === null) return null;
    return parseRunState(JSON.parse(content));
  } catch (error) {
    logStateDiagnostic(`ignoring unreadable run-state file: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function writeRunState(input: RunStateInput): void {
  const record: RunState = {
    iteration: input.iteration,
    stepIndex: input.stepIndex,
    stepName: input.stepName,
    ...(input.sessionID !== undefined ? { sessionID: input.sessionID } : {}),
    ...(input.messageID !== undefined ? { messageID: input.messageID } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomically(runStateFilePath(), `${JSON.stringify(record, null, 2)}\n`);
}

export function clearRunStateFile(): void {
  tolerantRm(runStateFilePath());
}

export function readLastBranch() {
  const content = tolerantRead(lastBranchFilePath());
  if (content === null) return null;
  const branch = content.trim();
  return branch ? branch : null;
}

export function writeLastBranch(branch: string) {
  writeFileAtomically(lastBranchFilePath(), `${branch}\n`);
}
