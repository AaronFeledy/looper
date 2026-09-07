import { branchHintFor, BRANCH_POLL_INTERVAL_MS } from "./title-coordinator.ts";
import { storyIdFromBranch } from "../lib/story-id.ts";

export type StoryBranchMismatch = {
  readonly branch: string;
  readonly pattern: string;
};

export function decideStoryBranchMismatch(input: {
  readonly initialBranch: string | undefined;
  readonly currentBranch: string | undefined;
  readonly pattern: string;
}): StoryBranchMismatch | undefined {
  const current = input.currentBranch;
  if (current === undefined || current === input.initialBranch) return undefined;
  if (branchHintFor(current) === undefined) return undefined;
  if (storyIdFromBranch(current, input.pattern) !== undefined) return undefined;
  return { branch: current, pattern: input.pattern };
}

export function storyBranchMismatchPrompt(mismatch: StoryBranchMismatch): string {
  return [
    "Continue working to completion if you haven't already.",
    `A branch switch to '${mismatch.branch}' was detected; that name is not a story branch (it does not match ${mismatch.pattern}).`,
    "If this branch is meant to build a user story, rename it so the name matches that pattern, then continue.",
    "If the work is already complete, report the result.",
    "",
  ].join("\n");
}

export function storyBranchMismatchLogLine(mismatch: StoryBranchMismatch): string {
  return `[looper] branch '${mismatch.branch}' does not match story id pattern ${mismatch.pattern}`;
}

export type StoryBranchMismatchMonitor = {
  readonly stop: () => void;
  readonly mismatch: () => StoryBranchMismatch | undefined;
};

export function createStoryBranchMismatchMonitor(input: {
  readonly initialBranch: string | undefined;
  readonly getBranch: () => string | undefined;
  readonly pattern: string;
  readonly onMismatch?: (mismatch: StoryBranchMismatch) => void;
  readonly pollIntervalMs?: number;
}): StoryBranchMismatchMonitor {
  let lastLoggedBranch: string | undefined;
  const mismatch = (): StoryBranchMismatch | undefined =>
    decideStoryBranchMismatch({
      initialBranch: input.initialBranch,
      currentBranch: input.getBranch(),
      pattern: input.pattern,
    });

  const poll = (): void => {
    const current = mismatch();
    if (current === undefined) {
      lastLoggedBranch = undefined;
      return;
    }
    if (current.branch === lastLoggedBranch) return;
    lastLoggedBranch = current.branch;
    input.onMismatch?.(current);
  };

  const timer = setInterval(poll, input.pollIntervalMs ?? BRANCH_POLL_INTERVAL_MS);
  timer.unref?.();
  poll();

  return {
    stop: () => {
      clearInterval(timer);
    },
    mismatch,
  };
}
