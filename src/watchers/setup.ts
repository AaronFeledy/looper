import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { branchDiffCollectionTimeoutMs } from "../config/tunables.ts";
import type { StoryPhaseResolver } from "../engine/story-phases.ts";
import { detectGithubRepo } from "../lib/github.ts";
import { watchBranch } from "./branch.ts";
import { collectBranchDiff } from "./branch-diff.ts";
import { watchBranchDiff, type BranchDiffWatcher } from "./branch-diff-watcher.ts";
import { watchGithubPr, type GithubWatcher } from "./github.ts";
import { readResolvedPrdStatus, watchPrd, type PrdWatcher } from "./prd.ts";
import type { BranchDiffWatcherEvent, BranchWatcherEvent, GithubWatcherEvent, PrdWatcherEvent } from "./watcher-events.ts";

export type BranchWatcherHandle = {
  readonly refresh: () => void;
  readonly stop: () => void;
};

export async function startBranchWatcher(opts: {
  readonly repoDir: string;
  readonly emit: (event: BranchWatcherEvent) => void;
}): Promise<BranchWatcherHandle> {
  const watcher = await watchBranch({
    repoDir: opts.repoDir,
    onChange: (branch) => opts.emit({ kind: "branch-change", branch }),
  });

  let safetyTimer: ReturnType<typeof setInterval> | undefined;
  if (watcher !== null) {
    safetyTimer = setInterval(() => watcher.refresh(), 60_000);
    safetyTimer.unref?.();
  }

  return {
    refresh: () => watcher?.refresh(),
    stop: () => {
      if (safetyTimer !== undefined) clearInterval(safetyTimer);
      watcher?.stop();
    },
  };
}

export async function startGithubWatcher(opts: {
  readonly repoDir: string;
  readonly getBranch: () => string;
  readonly emit: (event: GithubWatcherEvent) => void;
  readonly onEnabled: () => void;
}): Promise<GithubWatcher | undefined> {
  if (!(await detectGithubRepo(opts.repoDir))) return undefined;
  opts.onEnabled();
  return watchGithubPr({
    repoDir: opts.repoDir,
    getBranch: opts.getBranch,
    onUpdate: (status) => opts.emit({ kind: "github-status", status }),
  });
}

export function startBranchDiffWatcher(opts: {
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly prdDir?: string;
  readonly getBranch: () => string;
  readonly emit: (event: BranchDiffWatcherEvent) => void;
}): BranchDiffWatcher {
  return watchBranchDiff({
    getBranch: opts.getBranch,
    collectionTimeoutMs: branchDiffCollectionTimeoutMs(),
    collect: (branch, signal) => collectBranchDiff(opts.client, opts.repoDir, branch, signal, opts.prdDir),
    onUpdate: (status) => opts.emit({ kind: "branch-diff", status }),
  });
}

export function startPrdWatcher(opts: {
  readonly prdDir: string | undefined;
  readonly emit: (event: PrdWatcherEvent) => void;
  readonly onEnabled: () => void;
  readonly storyResolver?: StoryPhaseResolver;
}): PrdWatcher | undefined {
  if (opts.prdDir === undefined) return undefined;
  opts.onEnabled();
  const resolver = opts.storyResolver;
  return watchPrd({
    prdDir: opts.prdDir,
    onUpdate: (status) => opts.emit({ kind: "prd-status", status }),
    ...(resolver !== undefined ? { read: () => readResolvedPrdStatus(resolver) } : {}),
  });
}
