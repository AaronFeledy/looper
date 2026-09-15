import { branchHintFor, BRANCH_POLL_INTERVAL_MS } from "./title-coordinator.ts";
import { storyIdFromBranch } from "../lib/story-id.ts";

export type StoryBranchMismatch = {
  readonly branch: string;
  readonly pattern: string;
  readonly expectedStoryId?: string;
  readonly suggestedBranch?: string;
};

export function decideStoryBranchMismatch(input: {
  readonly initialBranch: string | undefined;
  readonly currentBranch: string | undefined;
  readonly pattern: string;
  readonly storyIds?: readonly string[];
}): StoryBranchMismatch | undefined {
  const current = input.currentBranch;
  if (current === undefined || current === input.initialBranch) return undefined;
  if (branchHintFor(current) === undefined) return undefined;
  if (storyIdFromBranch(current, input.pattern, input.storyIds) !== undefined) return undefined;
  const basename = current.split("/").at(-1)!;
  const expectedStoryId = storyIdFromBranch(basename, input.pattern, input.storyIds);
  return {
    branch: current,
    pattern: input.pattern,
    ...(expectedStoryId !== undefined ? { expectedStoryId, suggestedBranch: basename } : {}),
  };
}

export function storyBranchMismatchPrompt(mismatch: StoryBranchMismatch): string {
  return [
    "Repair the current branch name before completing this step.",
    `A branch switch to '${mismatch.branch}' was detected; Looper cannot resolve its story ID.`,
    "When a PRD is configured, use the exact intended story ID from prd.json followed by '-' and a description; preserve the full ID, including any split-story suffix.",
    "Without a PRD, use the naming pattern below while preserving the intended story ID.",
    `The fallback story-id pattern for this run is ${mismatch.pattern} (capture group 1 is the story ID).`,
    ...(mismatch.expectedStoryId !== undefined ? [`Expected story ID: ${mismatch.expectedStoryId}. Suggested branch name: '${mismatch.suggestedBranch}'.`] : []),
    "Rename the current branch with git branch -m, preserving its commits and working-tree changes. Verify the name with git branch --show-current.",
    "Do not edit Looper configuration, change PRD story IDs, stop or restart Looper, or signal stop to resolve this naming mismatch.",
    "Completing the implementation does not complete this repair. Looper will re-read the branch before advancing.",
    "If an identity-preserving rename is impossible, explain the specific blocker in your reply and leave Looper running.",
    "",
  ].join("\n");
}

export function storyBranchMismatchLogLine(mismatch: StoryBranchMismatch): string {
  return `[looper] branch '${mismatch.branch}' has no recognized story ID (PRD ID prefix or pattern ${mismatch.pattern})`;
}

export type StoryBranchMismatchMonitor = {
  readonly stop: () => void;
  readonly mismatch: () => StoryBranchMismatch | undefined;
};

export function createStoryBranchMismatchMonitor(input: {
  readonly initialBranch: string | undefined;
  readonly getBranch: () => string | undefined;
  readonly getStoryIds?: () => readonly string[] | undefined;
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
      storyIds: input.getStoryIds?.(),
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
