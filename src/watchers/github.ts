import { fetchPrStatus } from "../lib/github.ts";
import type { GithubStatus } from "./watcher-events.ts";

export const DEFAULT_GITHUB_POLL_INTERVAL_MS = 15_000;

export type GithubWatcher = {
  refresh: () => void;
  stop: () => void;
};

/**
 * Poll `gh pr view` for the current branch on an interval and push each result
 * to `onUpdate`. Modeled on the branch watcher: it fires once immediately, the
 * timer is `unref`'d so it never blocks process exit, and `refresh()` lets
 * callers force an out-of-band poll (e.g. right after a branch switch or a push
 * step, when CI is most likely to have just changed).
 *
 * A single poll is kept in flight at a time so a slow `gh` call can't pile up
 * overlapping requests behind the interval.
 */
export function watchGithubPr(opts: {
  repoDir: string;
  getBranch: () => string;
  onUpdate: (status: GithubStatus) => void;
  pollIntervalMs?: number;
  fetchStatus?: (repoDir: string, branch: string, signal?: AbortSignal) => Promise<GithubStatus>;
}): GithubWatcher {
  const fetchStatus = opts.fetchStatus ?? fetchPrStatus;
  const controller = new AbortController();
  let stopped = false;
  let inFlight = false;
  let pendingRefresh = false;

  const run = async (): Promise<void> => {
    if (stopped) return;
    // Collapse concurrent triggers: a refresh during an in-flight poll is
    // queued, then drained once the current poll settles, so back-to-back
    // branch switches / step hooks are never silently dropped.
    if (inFlight) {
      pendingRefresh = true;
      return;
    }
    inFlight = true;
    try {
      do {
        pendingRefresh = false;
        const branch = opts.getBranch();
        let status: GithubStatus;
        try {
          status = await fetchStatus(opts.repoDir, branch, controller.signal);
        } catch (error) {
          status = { kind: "error", message: error instanceof Error ? error.message : String(error) };
        }
        if (stopped) return;
        // Drop a result whose branch is already stale; the loop will re-poll
        // for the branch that's now current.
        if (opts.getBranch() !== branch) {
          pendingRefresh = true;
          continue;
        }
        opts.onUpdate(status);
      } while (pendingRefresh && !stopped);
    } finally {
      inFlight = false;
    }
  };

  void run();

  const timer = setInterval(() => void run(), opts.pollIntervalMs ?? DEFAULT_GITHUB_POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    refresh: () => void run(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      controller.abort();
    },
  };
}
