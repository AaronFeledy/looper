import { $ } from "bun";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const HEAD_REF_PREFIX = "ref: refs/heads/";

function logBranchDiagnostic(message: string): void {
  if (process.env.LOOPER_DEBUG_EVENTS === "1") console.error(`[looper] branch-watcher: ${message}`);
}

/** Default polling interval for the background watcher. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Parse the contents of a git HEAD file.
 *
 * - `ref: refs/heads/<name>\n` → `<name>`
 * - raw SHA → `"detached"`
 * - empty / unrecognized → `null` (caller should keep prior value)
 */
export function parseHeadContents(raw: string): string | null {
  const trimmed = raw.replace(/\r?\n+$/, "");
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith(HEAD_REF_PREFIX)) {
    const name = trimmed.slice(HEAD_REF_PREFIX.length).trim();
    return name.length > 0 ? name : "detached";
  }
  // A raw OID means detached HEAD. Anything else is unexpected; treat as detached
  // rather than null so we don't strand the UI on a stale value.
  return "detached";
}

/**
 * Resolve the absolute path to the HEAD file for the given working dir.
 *
 * Uses `git rev-parse --git-dir` so worktrees and submodules (where `.git` is a
 * file, not a directory) resolve to the correct per-worktree HEAD.
 *
 * Returns `null` if the directory is not part of a git repo.
 */
export async function resolveGitHeadPath(repoDir: string): Promise<string | null> {
  const result = await $`git rev-parse --git-dir`.cwd(repoDir).quiet().nothrow();
  if (result.exitCode !== 0) return null;
  const gitDir = result.stdout.toString().trim();
  if (gitDir.length === 0) return null;
  const absolute = isAbsolute(gitDir) ? gitDir : join(repoDir, gitDir);
  return join(absolute, "HEAD");
}

/** Synchronously read and parse HEAD; returns null on any I/O or parse failure. */
export function readBranchFromHead(headPath: string): string | null {
  try {
    return parseHeadContents(readFileSync(headPath, "utf8"));
  } catch (error) {
    logBranchDiagnostic(`failed to read HEAD at ${headPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export type BranchWatcher = {
  /** Branch name observed at watcher start, or null if HEAD couldn't be read. */
  initial: string | null;
  /**
   * Re-read HEAD synchronously and fire `onChange` if the branch changed since
   * the last observed value. Safe to call from anywhere — used by the loop's
   * step transitions and the 60s safety timer as a belt-and-braces fallback
   * around the 5s background poll.
   */
  refresh: () => void;
  stop: () => void;
};

/**
 * Poll HEAD every `pollIntervalMs` and invoke `onChange` whenever the branch
 * changes. Polling is used instead of `fs.watch` because Bun's inotify
 * integration silently drops the rename events that `git checkout` emits —
 * direct writes to HEAD fire events, but real-world checkouts do not.
 *
 * - `onChange` is called with the initial value (if any) before this function
 *   returns, so the caller can seed its UI without a separate read.
 * - Returns `null` when the directory isn't a git repo; the caller can decide
 *   whether to fall back to a one-shot read.
 * - The interval timer is `unref`'d, so a running watcher won't block process
 *   exit on its own.
 */
export async function watchBranch(opts: {
  repoDir: string;
  onChange: (branch: string) => void;
  /** Defaults to {@link DEFAULT_POLL_INTERVAL_MS} (5 000 ms). */
  pollIntervalMs?: number;
}): Promise<BranchWatcher | null> {
  const headPath = await resolveGitHeadPath(opts.repoDir);
  if (headPath === null) return null;

  const initial = readBranchFromHead(headPath);
  if (initial !== null) opts.onChange(initial);

  let lastBranch = initial;
  let stopped = false;

  const refresh = (): void => {
    if (stopped) return;
    const next = readBranchFromHead(headPath);
    if (next === null || next === lastBranch) return;
    lastBranch = next;
    opts.onChange(next);
  };

  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timer = setInterval(refresh, interval);
  // Don't keep the event loop alive just for this background poller.
  timer.unref?.();

  return {
    initial,
    refresh,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
