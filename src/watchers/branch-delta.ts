import { $ } from "bun";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { promptVcsTimeoutMs } from "../config/tunables.ts";
import type { VcsSnapshot } from "../lib/prompt-context.ts";

function formatError(error: unknown): string {
  if (error === undefined || error === null) return "unknown error";
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string") return message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Base branches tried, in order, to find the branch's mainline base. */
export const FALLBACK_BASE_BRANCHES = ["origin/main", "origin/master", "main", "master"];

/** Bare branch names (i.e. ignoring any `<remote>/` prefix) considered a mainline base. */
export const MAINLINE_BRANCH_NAMES = ["main", "master"];

/**
 * True when `ref` (e.g. `origin/main`, `upstream/main`, or a bare `main`)
 * names a mainline branch. Used to decide whether the current branch's OWN
 * upstream tracking ref is a legitimate branch-delta base: a feature branch
 * tracking `origin/<same-feature-branch>` must NOT be used as its own base
 * (comparing HEAD to its own upstream reports 0 commits ahead as soon as
 * it's pushed, even when it has a large delta vs `main`) - only an upstream
 * that itself points at a mainline branch qualifies.
 */
export function isMainlineRef(ref: string): boolean {
  const shortName = ref.split("/").pop() ?? ref;
  return MAINLINE_BRANCH_NAMES.includes(shortName);
}

export type BranchDeltaChange = { readonly file: string; readonly additions: number; readonly deletions: number; readonly status: string };
export type BranchDelta = { readonly base: string; readonly aheadCount: number; readonly changes: BranchDeltaChange[] };

/**
 * Commits HEAD is ahead of `base` in `repoDir`, or `undefined` when `base`
 * doesn't resolve to a ref there. A bad ref is a normal "nothing to compare"
 * outcome (fresh repo, unrelated base name), not a failure - callers treat
 * `undefined` as "try the next candidate", not as an error.
 */
export async function commitsAheadOfRef(repoDir: string, base: string): Promise<number | undefined> {
  const result = await $`git rev-list --count ${base}..HEAD`.cwd(repoDir).quiet().nothrow();
  if (result.exitCode !== 0) return undefined;
  const count = Number.parseInt(result.stdout.toString().trim(), 10);
  return Number.isFinite(count) ? count : undefined;
}

/** Maps a `git diff --name-status` single-letter code to the same status vocabulary `vcs.status` uses. */
export function normalizeGitStatusCode(code: string): string {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  return "modified";
}

/**
 * Parses NUL-separated `git diff --numstat -z` output into a file -> stat
 * map. Binary files report `-`/`-` for added/deleted, which parse to `0`
 * (matching how `vcs.status` already treats unknown stats).
 */
export function parseNumstatZ(raw: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const record of raw.split("\0")) {
    if (record.length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = record.split("\t");
    const file = pathParts.join("\t");
    if (file.length === 0) continue;
    const additions = Number.parseInt(addedRaw ?? "", 10);
    const deletions = Number.parseInt(deletedRaw ?? "", 10);
    stats.set(file, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return stats;
}

/** Parses NUL-separated `git diff --name-status -z` output (alternating code, path, code, path, ...) into a file -> status map, preserving diff order. */
export function parseNameStatusZ(raw: string): Map<string, string> {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const statuses = new Map<string, string>();
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const code = tokens[i];
    const file = tokens[i + 1];
    if (code === undefined || file === undefined) continue;
    statuses.set(file, normalizeGitStatusCode(code));
  }
  return statuses;
}

/**
 * Files changed by the branch's committed delta vs `base` - i.e. `git diff
 * <base>...HEAD` (merge-base relative, so upstream-only commits on `base`
 * never leak in; verified in a scratch repo). `--no-renames` avoids the
 * ambiguous `old => new` numstat path syntax by reporting a rename as a
 * plain delete+add pair, matching opencode's own `git diff` flag choices
 * (`packages/opencode/src/git/index.ts`). Empty (never throws) on any git
 * failure - the caller only reaches this after `base` is already confirmed
 * to have commits ahead, so a failure here just means an emptier file list,
 * not a broken ahead-count.
 */
export async function branchDeltaChangedFiles(repoDir: string, base: string): Promise<BranchDeltaChange[]> {
  const [numstat, nameStatus] = await Promise.all([
    $`git diff --no-ext-diff --no-renames --numstat -z ${base}...HEAD`.cwd(repoDir).quiet().nothrow(),
    $`git diff --no-ext-diff --no-renames --name-status -z ${base}...HEAD`.cwd(repoDir).quiet().nothrow(),
  ]);
  if (numstat.exitCode !== 0 || nameStatus.exitCode !== 0) return [];
  const stats = parseNumstatZ(numstat.stdout.toString());
  const statuses = parseNameStatusZ(nameStatus.stdout.toString());
  const changes: BranchDeltaChange[] = [];
  for (const [file, status] of statuses) {
    const stat = stats.get(file);
    changes.push({ file, additions: stat?.additions ?? 0, deletions: stat?.deletions ?? 0, status });
  }
  return changes;
}

/**
 * The branch's committed delta vs its mainline base (`FALLBACK_BASE_BRANCHES`,
 * plus the branch's own upstream tracking ref FIRST if - and only if - that
 * upstream itself is a mainline branch): how many commits ahead, and which
 * files those commits touched. Resolves to `undefined` when there's no base
 * to compare against, or the branch has 0 commits ahead (i.e. checked out
 * on the base branch itself) - both normal states, not failures.
 */
export async function resolveBranchDelta(repoDir: string): Promise<BranchDelta | undefined> {
  const upstream = await $`git rev-parse --abbrev-ref --symbolic-full-name @{u}`.cwd(repoDir).quiet().nothrow();
  const upstreamRef = upstream.exitCode === 0 ? upstream.stdout.toString().trim() : "";
  const mainlineUpstream = upstreamRef.length > 0 && isMainlineRef(upstreamRef) ? [upstreamRef] : [];
  const candidates = [...new Set([...mainlineUpstream, ...FALLBACK_BASE_BRANCHES])];
  for (const base of candidates) {
    const aheadCount = await commitsAheadOfRef(repoDir, base);
    if (aheadCount === undefined) continue;
    if (aheadCount === 0) return undefined;
    const changes = await branchDeltaChangedFiles(repoDir, base);
    return { base, aheadCount, changes };
  }
  return undefined;
}

/**
 * Bounded, fail-open wrapper around `resolveBranchDelta` for the fresh,
 * per-prompt-send fetch. A timeout or thrown error (e.g. missing `git`
 * binary) logs one `[looper]` line and resolves to `undefined`; a
 * non-git-repo or "no base branch" outcome resolves to `undefined` silently,
 * since that's an expected state rather than a fetch failure.
 */
export async function fetchBranchDelta(repoDir: string, log: (line: string) => void): Promise<BranchDelta | undefined> {
  const timeoutMs = promptVcsTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolveBranchDelta(repoDir),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`branch delta timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    log(`[looper] prompt branch delta fetch threw: ${formatError(error)}`);
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fetches the working-tree delta and the branch's committed delta (vs its
 * resolved base) for the `<looper-context>` prompt block, fresh immediately
 * before each prompt send. Never throws: a timeout, error, or missing
 * `vcs.status` capability logs one `[looper]` line via `log` and resolves to
 * `undefined` (section omitted), so a hanging or unsupported server can
 * never block a step. The working-tree fetch and the branch-delta fetch are
 * independently bounded; a snapshot is still returned (with `branchDelta`
 * absent) if only the branch-delta fetch fails, since the working-tree data
 * remains useful on its own.
 */
export async function fetchPromptVcsDelta(
  client: OpencodeClient,
  repoDir: string,
  branch: string | undefined,
  log: (line: string) => void,
): Promise<VcsSnapshot | undefined> {
  const timeoutMs = promptVcsTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      client.vcs.status({ directory: repoDir }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`vcs.status timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    if (status.error) {
      log(`[looper] prompt vcs delta fetch failed: ${formatError(status.error)}`);
      return undefined;
    }
    const changes = (status.data ?? []).map((change) => ({
      file: change.file,
      additions: change.additions,
      deletions: change.deletions,
      status: change.status,
    }));
    const branchDelta = await fetchBranchDelta(repoDir, log);
    return { ...(branch !== undefined ? { branch } : {}), changes, ...(branchDelta !== undefined ? { branchDelta } : {}) };
  } catch (error) {
    log(`[looper] prompt vcs delta fetch threw: ${formatError(error)}`);
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
