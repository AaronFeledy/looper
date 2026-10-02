import { join } from "node:path";
import { withFileTransaction } from "../persistence/file-transaction.ts";

import { requireConfigDir, tolerantRead, tolerantRm, writeFileAtomically } from "./state-files.ts";

const STEP_ATTEMPT_FILE_NAME = ".looper-step-attempts.json";

/** Why a step did not advance its story. `noop` outcomes are never recorded. */
export type StepAttemptKind = "handback" | "blocked";

export type StepAttemptRecord = {
  readonly count: number;
  readonly lastAt: string;
  readonly lastKind: StepAttemptKind;
  readonly lastReason?: string;
};

type StepAttemptFile = {
  /** storyId -> stepName -> consecutive non-advancing attempts. */
  readonly attempts: Readonly<Record<string, Readonly<Record<string, StepAttemptRecord>>>>;
};

function stepAttemptPath(): string {
  return join(requireConfigDir(), STEP_ATTEMPT_FILE_NAME);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): StepAttemptRecord | undefined {
  if (!isRecord(value)) return undefined;
  const count = value["count"];
  const lastAt = value["lastAt"];
  const lastKind = value["lastKind"];
  const lastReason = value["lastReason"];
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
  if (typeof lastAt !== "string" || lastAt.length === 0) return undefined;
  if (lastKind !== "handback" && lastKind !== "blocked") return undefined;
  return {
    count,
    lastAt,
    lastKind,
    ...(typeof lastReason === "string" && lastReason.length > 0 ? { lastReason } : {}),
  };
}

/** Malformed entries are skipped while valid peers survive (mirrors story state). */
function parseFile(content: string | null): StepAttemptFile {
  if (content === null) return { attempts: Object.create(null) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // no-excuse-ok: catch -- the ledger is a tolerant counter; unreadable state is an empty ledger
    return { attempts: Object.create(null) };
  }
  if (!isRecord(parsed) || !isRecord(parsed["attempts"])) return { attempts: Object.create(null) };

  const attempts: Record<string, Record<string, StepAttemptRecord>> = Object.create(null);
  for (const [storyId, steps] of Object.entries(parsed["attempts"])) {
    if (storyId.length === 0 || !isRecord(steps)) continue;
    const parsedSteps: Record<string, StepAttemptRecord> = Object.create(null);
    for (const [stepName, entry] of Object.entries(steps)) {
      if (stepName.length === 0) continue;
      const record = parseRecord(entry);
      if (record !== undefined) parsedSteps[stepName] = record;
    }
    if (Object.keys(parsedSteps).length > 0) attempts[storyId] = parsedSteps;
  }
  return { attempts };
}

function readFile(): StepAttemptFile {
  try {
    return parseFile(tolerantRead(stepAttemptPath()));
  } catch {
    // no-excuse-ok: catch -- an unreadable ledger must never fail a step
    return { attempts: Object.create(null) };
  }
}

export function readStepAttempt(storyId: string, stepName: string): StepAttemptRecord | undefined {
  return readFile().attempts[storyId]?.[stepName];
}

export function readStoryStepAttempts(storyId: string): Readonly<Record<string, StepAttemptRecord>> {
  return readFile().attempts[storyId] ?? Object.create(null);
}

function write(file: StepAttemptFile): void {
  writeFileAtomically(stepAttemptPath(), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Increment the consecutive non-advancing attempt count for (story, step) and
 * return the new count. Read/modify/write happens inside the interprocess
 * transaction so two writers can never lose a count.
 */
export function recordStepNonAdvance(input: {
  readonly storyId: string;
  readonly stepName: string;
  readonly kind: StepAttemptKind;
  readonly reason?: string;
  readonly at?: Date;
}): number {
  if (input.storyId.trim().length === 0 || input.stepName.trim().length === 0) return 0;
  let next = 0;
  withFileTransaction(requireConfigDir(), () => {
    const current = readFile();
    const previous = current.attempts[input.storyId]?.[input.stepName]?.count ?? 0;
    next = previous + 1;
    const record: StepAttemptRecord = {
      count: next,
      lastAt: (input.at ?? new Date()).toISOString(),
      lastKind: input.kind,
      ...(input.reason !== undefined && input.reason.length > 0 ? { lastReason: input.reason } : {}),
    };
    write({
      attempts: {
        ...current.attempts,
        [input.storyId]: { ...current.attempts[input.storyId], [input.stepName]: record },
      },
    });
  });
  return next;
}

/** Clear one (story, step) counter. Called when that step advances the story. */
export function clearStepAttempt(storyId: string, stepName: string): void {
  if (storyId.trim().length === 0 || stepName.trim().length === 0) return;
  withFileTransaction(requireConfigDir(), () => {
    const current = readFile();
    const steps = current.attempts[storyId];
    if (steps?.[stepName] === undefined) return;
    const remaining = Object.fromEntries(Object.entries(steps).filter(([name]) => name !== stepName));
    const attempts = { ...current.attempts };
    if (Object.keys(remaining).length === 0) delete attempts[storyId];
    else attempts[storyId] = remaining;
    write({ attempts });
  });
}

export function clearStepAttempts(): void {
  withFileTransaction(requireConfigDir(), () => tolerantRm(stepAttemptPath()));
}
