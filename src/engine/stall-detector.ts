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

      const progressed =
        prev === undefined ||
        observation.hasMaterialChange ||
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

export function materialPathsExist(paths: readonly string[], prdRel: string | undefined): boolean {
  if (prdRel === undefined || prdRel === "" || prdRel.startsWith("..")) return paths.length > 0;
  const prefix = prdRel.endsWith("/") ? prdRel : `${prdRel}/`;
  return paths.some((path) => path !== prdRel && !path.startsWith(prefix));
}

export type StallObserver = {
  readonly checkIteration: (branch: string) => Promise<StallVerdict>;
};

export type CreateStallObserverInput = {
  readonly repoDir: string;
  readonly limits: StallLimits;
  readonly prdDir?: string;
  readonly storyIdPattern?: string;
  readonly readPhase?: (storyId: string) => string | undefined;
  readonly readCompletionsCount: () => number;
  readonly readPasses?: (prdDir: string) => PrdPassesMap | undefined;
};

export function createStallObserver(input: CreateStallObserverInput): StallObserver {
  const detector = createStallDetector({ limits: input.limits, initialAdjudicationCompletions: input.readCompletionsCount() });
  const readPasses = input.readPasses ?? readPrdPasses;
  const prdRel = input.prdDir === undefined ? undefined : relative(input.repoDir, input.prdDir).replaceAll("\\", "/");
  let prevHead: string | undefined;

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

      const storyId = storyIdFromBranch(branch, input.storyIdPattern);
      return detector.observe({
        branch,
        storyId,
        headCommit: head,
        hasMaterialChange,
        passes: input.prdDir === undefined ? undefined : readPasses(input.prdDir),
        phase: storyId === undefined ? undefined : input.readPhase?.(storyId),
        adjudicationCompletions: input.readCompletionsCount(),
      });
    },
  };
}
