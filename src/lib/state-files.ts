import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
// allow: SIZE_OK — this file is state-file I/O for the resume pointer and its
// stepSessions ledger; the required parse/write/upsert/resume-plan surface
// pushes it past the 250-pure-LOC guideline, and Todo 4's authorized file
// scope (state-files.ts, main.ts, fallback.ts, tests only) forbids splitting
// it into a new module. Follow-up split tracked in the plan's notepad.
import { join } from "node:path";

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function logStateDiagnostic(message: string): void {
  if (process.env.LOOPER_DEBUG_EVENTS === "1") console.error(`[looper] state-files: ${message}`);
}

export function tolerantRm(path: string): void {
  try {
    rmSync(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
}

export function tolerantRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

export function writeFileAtomically(path: string, content: string): void {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, content, { mode: 0o600 });
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

export function requireConfigDir(): string {
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

export function regularFileExists(path: string): boolean {
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

/** Iteration-scoped record of the opencode session a logical step finished
 * with. Keyed by `stepIndex` (config position), not `name`, so duplicate step
 * names stay distinct. */
export type StepSessionEntry = {
  stepIndex: number;
  stepName: string;
  sessionID: string;
};

/**
 * Durable, iteration-aware run pointer (`.looper-run.json`). Superset of
 * {@link ResumeStep}: also records the iteration the loop is on and, while a
 * step is in flight, the opencode session, outcome turn, exact prompt, and
 * Looper-owned message IDs so a resume can reattach without exposing prompts.
 *
 * `sessionID`/`messageID`/`promptText`/`looperMessageIDs` are only present for
 * an IN-PROGRESS step; once it finishes the pointer advances WITHOUT those
 * fields, so resume never reattaches to an already-completed step.
 *
 * `title` is the iteration's generated work-description. It rides along with
 * the pointer (across step advances within an iteration) so a resumed run can
 * re-apply the title to steps that only inherit it, and is dropped when the
 * pointer crosses into a new iteration.
 * `looperRunID` identifies the process/logical run for SDK session metadata.
 * `stepSessions` follows the exact same lifecycle as `title`.
 */
export type RunState = {
  iteration: number;
  stepIndex: number;
  stepName: string;
  sessionID?: string;
  messageID?: string;
  promptText?: string;
  looperMessageIDs?: string[];
  title?: string;
  looperRunID?: string;
  stepSessions?: StepSessionEntry[];
  updatedAt: string;
};

export type RunStateInput = {
  iteration: number;
  stepIndex: number;
  stepName: string;
  sessionID?: string;
  messageID?: string;
  promptText?: string;
  looperMessageIDs?: string[];
  title?: string;
  looperRunID?: string;
  stepSessions?: StepSessionEntry[];
};

function parseStepSessionEntry(value: unknown): StepSessionEntry | null {
  if (!isRecord(value)) return null;
  const stepIndex = value.stepIndex;
  const stepName = value.stepName;
  const sessionID = value.sessionID;
  if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex) || stepIndex < 0) return null;
  if (typeof stepName !== "string" || stepName.length === 0) return null;
  if (typeof sessionID !== "string" || sessionID.length === 0) return null;
  return { stepIndex, stepName, sessionID };
}

/** Parses `stepSessions`, dropping invalid entries; a non-array value is
 * treated as absent (back-compat). */
function parseStepSessions(value: unknown): StepSessionEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: StepSessionEntry[] = [];
  for (const item of value) {
    const entry = parseStepSessionEntry(item);
    if (entry !== null) parsed.push(entry);
  }
  return parsed;
}

function parseMessageIDs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

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
  const promptText = typeof value.promptText === "string" ? value.promptText : undefined;
  const looperMessageIDs = parseMessageIDs(value.looperMessageIDs);
  const title = typeof value.title === "string" && value.title.length > 0 ? value.title : undefined;
  const looperRunID = typeof value.looperRunID === "string" && value.looperRunID.length > 0 ? value.looperRunID : undefined;
  const stepSessions = parseStepSessions(value.stepSessions);
  return {
    iteration,
    stepIndex,
    stepName,
    ...(sessionID !== undefined ? { sessionID } : {}),
    ...(messageID !== undefined ? { messageID } : {}),
    ...(promptText !== undefined ? { promptText } : {}),
    ...(looperMessageIDs !== undefined ? { looperMessageIDs } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(looperRunID !== undefined ? { looperRunID } : {}),
    ...(stepSessions !== undefined ? { stepSessions } : {}),
    updatedAt,
  };
}

/** Last-wins upsert by `stepIndex`, sorted in step order. Pure (does not
 * mutate `sessions`). */
export function upsertStepSession(sessions: StepSessionEntry[], entry: StepSessionEntry): StepSessionEntry[] {
  const next = sessions.filter((existing) => existing.stepIndex !== entry.stepIndex);
  next.push(entry);
  next.sort((a, b) => a.stepIndex - b.stepIndex);
  return next;
}

/** `runState.stepSessions`, but only when recorded for the SAME `iteration`
 * the caller is resuming into; a stale/mismatched iteration is ignored. */
export function stepSessionsForResume(runState: RunState | null, iteration: number): StepSessionEntry[] | undefined {
  if (runState === null) return undefined;
  if (runState.stepSessions === undefined) return undefined;
  if (runState.iteration !== iteration) return undefined;
  return runState.stepSessions;
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
    ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
    ...(input.looperMessageIDs !== undefined ? { looperMessageIDs: [...input.looperMessageIDs] } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.looperRunID !== undefined ? { looperRunID: input.looperRunID } : {}),
    ...(input.stepSessions !== undefined ? { stepSessions: input.stepSessions.map((entry) => ({ ...entry })) } : {}),
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
