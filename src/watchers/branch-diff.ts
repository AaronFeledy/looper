import { collectGitBranchDiff } from "./branch-diff-git.ts";

export type BranchDiffTotals = { readonly additions: number; readonly deletions: number; readonly files: number };

/**
 * Result of one SDK-backed branch-diff collection: `hidden` while checked out
 * on OpenCode's detected default branch, otherwise the aggregate committed +
 * worktree diff vs that default branch.
 */
export type BranchDiffCollection = { readonly kind: "hidden" } | { readonly kind: "ok"; readonly totals: BranchDiffTotals };

export type BranchDiffVcsResult<TData> = { readonly data?: TData; readonly error?: unknown };

export type BranchDiffVcsInfo = { readonly branch?: string; readonly default_branch?: string };

export type BranchDiffVcsFile = { readonly additions: number; readonly deletions: number };

export type BranchDiffVcsRequestOptions = { readonly signal?: AbortSignal };

export const MAX_BRANCH_DIFF_ERROR_CHARS = 300;
export const MAX_BRANCH_DIFF_SDK_FILES = 10_000;

class BranchDiffSdkFileLimitError extends Error {
  override readonly name = "BranchDiffSdkFileLimitError";

  constructor() {
    super(`SDK diff exceeded ${MAX_BRANCH_DIFF_SDK_FILES} files`);
  }
}

export function sanitizeBranchDiffError(message: string): string {
  const sanitized = message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return (sanitized.length === 0 ? "branch diff failed" : sanitized).slice(0, MAX_BRANCH_DIFF_ERROR_CHARS);
}

/**
 * Minimal structural view of the two OpenCode VCS calls this module needs. The
 * real `OpencodeClient` satisfies it structurally, so callers pass the SDK
 * client directly while tests construct just these two methods.
 */
export type BranchDiffVcsClient = {
  readonly vcs: {
    readonly get: (
      parameters: { readonly directory?: string },
      options?: BranchDiffVcsRequestOptions,
    ) => Promise<BranchDiffVcsResult<BranchDiffVcsInfo>>;
    readonly diff: (parameters: {
      readonly directory?: string;
      readonly mode: "branch";
      readonly context?: number;
    }, options?: BranchDiffVcsRequestOptions) => Promise<BranchDiffVcsResult<readonly BranchDiffVcsFile[]>>;
  };
};

function formatVcsError(error: unknown): string {
  let message: string;
  if (error === undefined || error === null) {
    message = "vcs request failed";
  } else if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    message = error.message;
  } else if (
    typeof error === "object"
    && "data" in error
    && typeof error.data === "object"
    && error.data !== null
    && "message" in error.data
    && typeof error.data.message === "string"
  ) {
    message = error.data.message;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  }
  return sanitizeBranchDiffError(message);
}

/** Sums per-file additions/deletions and counts files into the panel's aggregate totals. */
export function aggregateBranchDiff(changes: readonly BranchDiffVcsFile[]): BranchDiffTotals {
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    additions += change.additions;
    deletions += change.deletions;
  }
  return { additions, deletions, files: changes.length };
}

/**
 * Collect the aggregate branch diff via OpenCode's VCS API.
 *
 * `client.vcs.get` reports the current branch and OpenCode's detected default
 * branch; the panel hides only when the two are equal (so a feature branch
 * with zero changes still renders `+0 -0 0 files`). Otherwise
 * `client.vcs.diff({mode:"branch"})` returns the per-file diff computed against
 * the merge-base with the default branch (including untracked worktree files),
 * aggregated here into running totals.
 *
 * Throws on any SDK `.error` payload or transport failure so the watcher can
 * surface it as an error status.
 */
export async function collectBranchDiff(
  client: BranchDiffVcsClient,
  repoDir: string,
  authoritativeBranch: string,
  signal?: AbortSignal,
): Promise<BranchDiffCollection> {
  const requestOptions = signal === undefined ? undefined : { signal };
  const info = await client.vcs.get({ directory: repoDir }, requestOptions);
  if (info.error) throw new Error(formatVcsError(info.error));
  const sdkBranch = info.data?.branch;
  const defaultBranch = info.data?.default_branch;
  if (defaultBranch !== undefined && authoritativeBranch === defaultBranch) return { kind: "hidden" };
  if (sdkBranch !== authoritativeBranch) {
    return { kind: "ok", totals: await collectGitBranchDiff(repoDir, defaultBranch, signal) };
  }
  const diff = await client.vcs.diff({ directory: repoDir, mode: "branch", context: 0 }, requestOptions);
  if (diff.error) throw new Error(formatVcsError(diff.error));
  const files = diff.data ?? [];
  if (files.length > MAX_BRANCH_DIFF_SDK_FILES) throw new BranchDiffSdkFileLimitError();
  return { kind: "ok", totals: aggregateBranchDiff(files) };
}
