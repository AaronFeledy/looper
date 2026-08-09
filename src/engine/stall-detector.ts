import { createHash } from "node:crypto";
import { relative } from "node:path";

import type { PrdPassesMap } from "../lib/adjudication-detection.ts";
import { storyIdFromBranch } from "../lib/story-id.ts";
import { readPrdPasses } from "./adjudication-routing.ts";

const GIT_TIMEOUT_MS = 5_000;

export type StallLimits = {
  readonly iterations: number;
  readonly adjudications: number;
};

export type StallObservation = {
  readonly branch: string;
  readonly storyId: string | undefined;
  readonly headCommit: string | undefined;
  readonly hasMaterialChange: boolean;
  /** Material uncommitted work in the tree: `""` = clean, `undefined` = git unreadable. */
  readonly worktreeFingerprint: string | undefined;
  /** `true` when work is still running OR liveness could not be determined. */
  readonly inFlight: boolean;
  readonly passes: PrdPassesMap | undefined;
  readonly phase: string | undefined;
  readonly adjudicationCompletions: number;
};

export type StallVerdict = { readonly stalled: false } | { readonly stalled: true; readonly reason: string };

export type StallDetector = {
  readonly observe: (observation: StallObservation) => StallVerdict;
};

export function stallDetectionEnabled(limits: StallLimits): boolean {
  return limits.iterations > 0 || limits.adjudications > 0;
}

function worktreeAdvanced(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined) return true;
  return before !== after;
}

function passesEqual(a: PrdPassesMap | undefined, b: PrdPassesMap | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/**
 * Pure cross-iteration circuit breaker. An iteration counts as material
 * progress when it produced commits outside the PRD directory, changed the
 * PRD passes map, advanced the story phase, or moved to a different
 * story/branch. K consecutive non-progress iterations, or M completed
 * adjudications for one story within a run, is an unbreakable loop: every
 * step can succeed and every gate can legitimately pass while the run as a
 * whole goes nowhere, so only this cross-iteration view can catch it.
 * Fail-open by design: unknown facts (git failures, unreadable PRD) count as
 * progress so a flaky environment can never stop a healthy run.
 */
export function createStallDetector(input: { readonly limits: StallLimits; readonly initialAdjudicationCompletions: number }): StallDetector {
  const { limits } = input;
  let prev: StallObservation | undefined;
  let noProgressCount = 0;
  let prevCompletions = input.initialAdjudicationCompletions;
  const adjudicationsByStory = new Map<string, number>();

  return {
    observe(observation) {
      const delta = Math.max(0, observation.adjudicationCompletions - prevCompletions);
      prevCompletions = Math.max(prevCompletions, observation.adjudicationCompletions);
      if (delta > 0 && limits.adjudications > 0) {
        const key = observation.storyId ?? observation.branch;
        const count = (adjudicationsByStory.get(key) ?? 0) + delta;
        adjudicationsByStory.set(key, count);
        if (count >= limits.adjudications) {
          prev = observation;
          return {
            stalled: true,
            reason: `stall detected: ${count} completed adjudications for ${key} in this run (limit ${limits.adjudications}). Repeated adjudication without durable resolution needs human review; see .looper-adjudication-log.json and the story's progress entries.`,
          };
        }
      }

      if (observation.inFlight) {
        // Work is still running (or liveness is unknown), so the loop is not
        // proven quiescent and a strike would be unearned. HOLD the counter
        // rather than resetting it: a wedged loop that always has a busy
        // session must still be able to trip on a later quiet iteration.
        // `prev` is deliberately NOT updated either: absorbing an in-flight
        // sample into the baseline would hide the work done during it, so the
        // next quiet observation would compare dirty-against-dirty and score a
        // strike for an iteration that actually made progress.
        return { stalled: false };
      }

      const progressed =
        prev === undefined ||
        observation.hasMaterialChange ||
        worktreeAdvanced(prev.worktreeFingerprint, observation.worktreeFingerprint) ||
        observation.branch !== prev.branch ||
        observation.storyId !== prev.storyId ||
        observation.phase !== prev.phase ||
        !passesEqual(observation.passes, prev.passes);
      prev = observation;
      if (progressed) {
        noProgressCount = 0;
        return { stalled: false };
      }
      noProgressCount += 1;
      if (limits.iterations > 0 && noProgressCount >= limits.iterations) {
        return {
          stalled: true,
          reason: `stall detected: ${noProgressCount} consecutive iterations with no material progress on ${observation.storyId ?? observation.branch} (limit ${limits.iterations}): no commits outside the PRD directory, no PRD passes change, no story phase change. The loop is spinning without advancing; human review required. HEAD ${observation.headCommit ?? "unknown"}.`,
        };
      }
      return { stalled: false };
    },
  };
}

async function gitStdout(repoDir: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    const [exitCode, stdout] = await Promise.all([child.exited, child.stdout.text()]);
    if (exitCode !== 0) return undefined;
    return stdout;
  } catch {
    // no-excuse-ok: catch -- this best-effort process boundary maps every spawn/read failure to undefined by contract
    return undefined;
  }
}

function materialPaths(paths: readonly string[], prdRel: string | undefined): string[] {
  if (prdRel === undefined || prdRel === "" || prdRel.startsWith("..")) return [...paths];
  const prefix = prdRel.endsWith("/") ? prdRel : `${prdRel}/`;
  return paths.filter((path) => path !== prdRel && !path.startsWith(prefix));
}

export function materialPathsExist(paths: readonly string[], prdRel: string | undefined): boolean {
  return materialPaths(paths, prdRel).length > 0;
}

function gitLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.length > 0);
}

async function probeWorktreeFingerprint(repoDir: string, prdRel: string | undefined): Promise<string | undefined> {
  const [tracked, untracked] = await Promise.all([
    gitStdout(repoDir, ["diff", "--name-only", "HEAD"]),
    gitStdout(repoDir, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (tracked === undefined || untracked === undefined) return undefined;
  const trackedPaths = materialPaths(gitLines(tracked), prdRel).sort();
  const untrackedPaths = materialPaths(gitLines(untracked), prdRel).sort();
  // PRD-only churn (a progress.txt rewritten every iteration) must read as a
  // clean tree, or the counter would reset forever and never trip.
  if (trackedPaths.length === 0 && untrackedPaths.length === 0) return "";

  // Hash the actual working-tree content, never a summary: a repo-wide
  // shortstat both moves on PRD churn the material path list excludes, and
  // stays put on a same-line-count edit or any untracked-file edit.
  const [patch, hashes] = await Promise.all([
    trackedPaths.length === 0 ? "" : gitStdout(repoDir, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", ...trackedPaths]),
    untrackedPaths.length === 0 ? "" : gitStdout(repoDir, ["hash-object", "--no-filters", "--", ...untrackedPaths]),
  ]);
  if (patch === undefined || hashes === undefined) return undefined;
  return createHash("sha256")
    .update(`tracked\n${trackedPaths.join("\n")}\nuntracked\n${untrackedPaths.join("\n")}\npatch\n${patch}\nhashes\n${hashes}`)
    .digest("hex");
}

export type StallObserver = {
  readonly checkIteration: (branch: string) => Promise<StallVerdict>;
  readonly confirmStall: (branch: string) => Promise<boolean>;
};

export type CreateStallObserverInput = {
  readonly repoDir: string;
  readonly limits: StallLimits;
  readonly prdDir?: string;
  readonly storyIdPattern?: string;
  readonly readPhase?: (storyId: string) => string | undefined;
  readonly readCompletionsCount: () => number;
  readonly readPasses?: (prdDir: string) => PrdPassesMap | undefined;
  readonly probeInFlight?: () => Promise<boolean>;
};

export function createStallObserver(input: CreateStallObserverInput): StallObserver {
  const detector = createStallDetector({ limits: input.limits, initialAdjudicationCompletions: input.readCompletionsCount() });
  const readPasses = input.readPasses ?? readPrdPasses;
  const probeInFlight = input.probeInFlight ?? (async () => false);
  const prdRel = input.prdDir === undefined ? undefined : relative(input.repoDir, input.prdDir).replaceAll("\\", "/");
  let prevHead: string | undefined;
  let lastObservation: StallObservation | undefined;

  return {
    async checkIteration(branch) {
      const head = (await gitStdout(input.repoDir, ["rev-parse", "HEAD"]))?.trim();
      let hasMaterialChange = true;
      if (head !== undefined && prevHead !== undefined) {
        if (head === prevHead) {
          hasMaterialChange = false;
        } else {
          const diff = await gitStdout(input.repoDir, ["diff", "--name-only", prevHead, head]);
          if (diff !== undefined) {
            hasMaterialChange = materialPathsExist(diff.split("\n").filter((line) => line.length > 0), prdRel);
          }
        }
      }
      if (head !== undefined) prevHead = head;
      const worktreeFingerprint = await probeWorktreeFingerprint(input.repoDir, prdRel);

      const storyId = storyIdFromBranch(branch, input.storyIdPattern);
      const passes = input.prdDir === undefined ? undefined : readPasses(input.prdDir);
      // A configured PRD that will not read is an UNKNOWN fact, not a stable
      // one, but `passesEqual(undefined, undefined)` reads as "no change" —
      // correct only when no PRD is configured at all. Fold the unreadable case
      // into the quiescence gate so it holds the counter instead of silently
      // scoring strikes against a fact nobody could observe.
      const passesUnknown = input.prdDir !== undefined && passes === undefined;
      lastObservation = {
        branch,
        storyId,
        headCommit: head,
        hasMaterialChange,
        worktreeFingerprint,
        inFlight: (await probeInFlight()) || passesUnknown,
        passes,
        phase: storyId === undefined ? undefined : input.readPhase?.(storyId),
        adjudicationCompletions: input.readCompletionsCount(),
      };
      return detector.observe(lastObservation);
    },

    async confirmStall(branch) {
      const tripped = lastObservation;
      if (tripped === undefined) return false;
      // Deliberately re-samples without touching `prevHead`, `lastObservation`,
      // or the detector: this is a second opinion on the verdict, not a strike.
      const [head, worktreeFingerprint, inFlight] = await Promise.all([
        gitStdout(input.repoDir, ["rev-parse", "HEAD"]),
        probeWorktreeFingerprint(input.repoDir, prdRel),
        probeInFlight(),
      ]);
      if (inFlight) return false;
      if (branch !== tripped.branch) return false;
      if (head?.trim() !== tripped.headCommit) return false;
      if (worktreeAdvanced(tripped.worktreeFingerprint, worktreeFingerprint)) return false;

      // PRD passes, story phase, and adjudications can all advance during the
      // settle window with no git change at all, so the verdict is only still
      // valid if every signal it was built from is also unchanged.
      const storyId = storyIdFromBranch(branch, input.storyIdPattern);
      if (storyId !== tripped.storyId) return false;
      if ((storyId === undefined ? undefined : input.readPhase?.(storyId)) !== tripped.phase) return false;
      if (input.readCompletionsCount() !== tripped.adjudicationCompletions) return false;
      const passes = input.prdDir === undefined ? undefined : readPasses(input.prdDir);
      if (input.prdDir !== undefined && (passes === undefined || tripped.passes === undefined)) return false;
      return passesEqual(passes, tripped.passes);
    },
  };
}
