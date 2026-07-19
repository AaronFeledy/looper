import { sanitizeBranchDiffError, type BranchDiffCollection } from "./branch-diff.ts";
import type { BranchDiffStatus } from "./watcher-events.ts";

export const DEFAULT_BRANCH_DIFF_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_BRANCH_DIFF_COLLECTION_TIMEOUT_MS = 10_000;

class BranchDiffCollectionTimeoutError extends Error {
  override readonly name = "BranchDiffCollectionTimeoutError";

  constructor(timeoutMs: number) {
    super(`branch diff collection timed out after ${timeoutMs}ms`);
  }
}

class BranchDiffCollectionCancelledError extends Error {
  override readonly name = "BranchDiffCollectionCancelledError";
}

export type BranchDiffWatcher = {
  readonly refresh: () => void;
  readonly stop: () => void;
};

/**
 * Recompute the aggregate branch diff via the injected SDK-backed `collect`
 * whenever asked (startup, branch switch, step begin/finish) plus a slow safety
 * poll. Modeled on the GitHub watcher: fires once immediately, `unref`s its
 * timer, keeps a single collection in flight, and drops a result whose branch
 * or request revision is already stale so a slow VCS call can never overwrite
 * a newer A -> B -> A refresh.
 *
 * `collect` receives the captured fast HEAD-derived branch and owns the hide
 * decision. This watcher maps its result to a {@link BranchDiffStatus}.
 */
export function watchBranchDiff(opts: {
  readonly getBranch: () => string;
  readonly onUpdate: (status: BranchDiffStatus) => void;
  readonly pollIntervalMs?: number;
  readonly collectionTimeoutMs?: number;
  readonly collect: (authoritativeBranch: string, signal: AbortSignal) => Promise<BranchDiffCollection>;
}): BranchDiffWatcher {
  const collect = opts.collect;
  const collectionTimeoutMs = opts.collectionTimeoutMs ?? DEFAULT_BRANCH_DIFF_COLLECTION_TIMEOUT_MS;
  let stopped = false;
  let inFlight = false;
  let pendingRefresh = false;
  let requestedRevision = 0;
  let publishedBranch: string | undefined;
  let loadingBranch: string | undefined;
  let activeController: AbortController | undefined;

  const collectBounded = async (branch: string, controller: AbortController): Promise<BranchDiffCollection> => {
    const signal = controller.signal;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new BranchDiffCollectionCancelledError("branch diff collection cancelled"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    });
    const timeout = setTimeout(() => controller.abort(new BranchDiffCollectionTimeoutError(collectionTimeoutMs)), collectionTimeoutMs);
    timeout.unref?.();
    try {
      return await Promise.race([collect(branch, signal), aborted]);
    } finally {
      clearTimeout(timeout);
      if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
    }
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      pendingRefresh = true;
      return;
    }
    inFlight = true;
    try {
      do {
        pendingRefresh = false;
        const branch = opts.getBranch();
        const revision = requestedRevision;
        const controller = new AbortController();
        activeController = controller;
        let status: BranchDiffStatus;
        try {
          const result = await collectBounded(branch, controller);
          status =
            result.kind === "hidden"
              ? { kind: "hidden" }
              : { kind: "ok", additions: result.totals.additions, deletions: result.totals.deletions, files: result.totals.files };
        } catch (error) {
          status = { kind: "error", message: sanitizeBranchDiffError(error instanceof Error ? error.message : String(error)) };
        } finally {
          if (activeController === controller) activeController = undefined;
        }
        if (stopped) return;
        if (opts.getBranch() !== branch || requestedRevision !== revision) {
          pendingRefresh = true;
          continue;
        }
        opts.onUpdate(status);
        publishedBranch = branch;
        loadingBranch = undefined;
      } while (pendingRefresh && !stopped);
    } finally {
      inFlight = false;
    }
  };

  const refresh = (): void => {
    if (stopped) return;
    requestedRevision += 1;
    activeController?.abort(new BranchDiffCollectionCancelledError("branch diff collection superseded"));
    const branch = opts.getBranch();
    if (publishedBranch !== undefined && publishedBranch !== branch && loadingBranch !== branch) {
      loadingBranch = branch;
      opts.onUpdate({ kind: "loading" });
    }
    void run();
  };

  refresh();

  const timer = setInterval(refresh, opts.pollIntervalMs ?? DEFAULT_BRANCH_DIFF_POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    refresh,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      activeController?.abort(new BranchDiffCollectionCancelledError("branch diff watcher stopped"));
    },
  };
}
