import { detectGithubRepo } from "../lib/github.ts";
import { watchBranch } from "./branch.ts";
import { watchGithubPr, type GithubWatcher } from "./github.ts";
import { watchPrd, type PrdWatcher } from "./prd.ts";
import type { BranchWatcherEvent, GithubWatcherEvent, PrdWatcherEvent } from "./watcher-events.ts";

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

export function startPrdWatcher(opts: {
  readonly prdDir: string | undefined;
  readonly emit: (event: PrdWatcherEvent) => void;
  readonly onEnabled: () => void;
}): PrdWatcher | undefined {
  if (opts.prdDir === undefined) return undefined;
  opts.onEnabled();
  return watchPrd({
    prdDir: opts.prdDir,
    onUpdate: (status) => opts.emit({ kind: "prd-status", status }),
  });
}
