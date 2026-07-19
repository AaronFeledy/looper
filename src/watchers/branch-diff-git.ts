import type { BranchDiffTotals, BranchDiffVcsFile } from "./branch-diff.ts";

export const BRANCH_DIFF_GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const BRANCH_DIFF_GIT_MAX_UNTRACKED_FILES = 1000;

const FALLBACK_BASE_REFS = ["origin/main", "origin/master", "main", "master"] as const;

class BranchDiffGitError extends Error {
  override readonly name = "BranchDiffGitError";
}

class BranchDiffGitCancelledError extends Error {
  override readonly name = "BranchDiffGitCancelledError";

  constructor() {
    super("branch diff Git fallback cancelled");
  }
}

class BranchDiffGitOutputLimitError extends Error {
  override readonly name = "BranchDiffGitOutputLimitError";

  constructor() {
    super(`branch diff Git output exceeded ${BRANCH_DIFF_GIT_MAX_OUTPUT_BYTES} bytes`);
  }
}

type GitResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new BranchDiffGitCancelledError();
}

async function readBounded(stream: ReadableStream<Uint8Array>, budget: { remaining: number }): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      budget.remaining -= result.value.byteLength;
      if (budget.remaining < 0) throw new BranchDiffGitOutputLimitError();
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString();
}

async function runGit(repoDir: string, args: readonly string[], signal: AbortSignal | undefined): Promise<GitResult> {
  throwIfCancelled(signal);
  const command = ["git", "-c", "core.fsmonitor=false", ...args];
  const spawnOptions = { cwd: repoDir, stdin: "ignore", stdout: "pipe", stderr: "pipe", killSignal: "SIGKILL" } as const;
  const proc = signal === undefined ? Bun.spawn(command, spawnOptions) : Bun.spawn(command, { ...spawnOptions, signal });
  const budget = { remaining: BRANCH_DIFF_GIT_MAX_OUTPUT_BYTES };
  const stdout = readBounded(proc.stdout, budget);
  const stderr = readBounded(proc.stderr, budget);
  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
    throwIfCancelled(signal);
    return { exitCode, stdout: stdoutText, stderr: stderrText };
  } catch (error) {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited;
    await Promise.allSettled([stdout, stderr]);
    throwIfCancelled(signal);
    throw error;
  }
}

function parseFirstGitNumstat(raw: string): BranchDiffVcsFile {
  const [record = ""] = raw.split("\0", 1);
  const [additionsRaw, deletionsRaw] = record.split("\t");
  const additions = Number.parseInt(additionsRaw ?? "", 10);
  const deletions = Number.parseInt(deletionsRaw ?? "", 10);
  return {
    additions: Number.isFinite(additions) ? additions : 0,
    deletions: Number.isFinite(deletions) ? deletions : 0,
  };
}

function parseGitNumstat(raw: string): Map<string, BranchDiffVcsFile> {
  const stats = new Map<string, BranchDiffVcsFile>();
  for (const record of raw.split("\0")) {
    if (record.length === 0) continue;
    const [, , ...pathParts] = record.split("\t");
    const path = pathParts.join("\t");
    if (path.length > 0) stats.set(path, parseFirstGitNumstat(record));
  }
  return stats;
}

function selectPrimaryRemote(remotes: readonly string[]): string | undefined {
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0];
  if (remotes.includes("upstream")) return "upstream";
  return remotes[0];
}

async function baseRefCandidates(repoDir: string, defaultBranch: string | undefined, signal: AbortSignal | undefined): Promise<readonly string[]> {
  if (defaultBranch === undefined) return FALLBACK_BASE_REFS;
  const remotesResult = await runGit(repoDir, ["remote"], signal);
  const remotes = remotesResult.exitCode === 0 ? remotesResult.stdout.split("\n").filter((remote) => remote.length > 0) : [];
  const primaryRemote = selectPrimaryRemote(remotes);
  let primaryRemoteHead: string | undefined;
  if (primaryRemote !== undefined) {
    const symbolicHead = await runGit(repoDir, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${primaryRemote}/HEAD`], signal);
    if (symbolicHead.exitCode === 0) {
      const candidate = symbolicHead.stdout.trim();
      const headBranch = candidate.startsWith(`${primaryRemote}/`) ? candidate.slice(primaryRemote.length + 1) : candidate;
      if (candidate === defaultBranch || headBranch === defaultBranch) primaryRemoteHead = candidate;
    }
  }
  return [...new Set([...(primaryRemoteHead === undefined ? [] : [primaryRemoteHead]), `origin/${defaultBranch}`, defaultBranch])];
}

async function resolveBaseRef(repoDir: string, defaultBranch: string | undefined, signal: AbortSignal | undefined): Promise<string> {
  for (const candidate of await baseRefCandidates(repoDir, defaultBranch, signal)) {
    throwIfCancelled(signal);
    const result = await runGit(repoDir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`], signal);
    if (result.exitCode === 0) return result.stdout.trim();
  }
  throw new BranchDiffGitError("unable to resolve a default branch ref for branch diff");
}

export async function collectGitBranchDiff(
  repoDir: string,
  defaultBranch: string | undefined,
  signal: AbortSignal | undefined,
): Promise<BranchDiffTotals> {
  const baseOid = await resolveBaseRef(repoDir, defaultBranch, signal);
  const headResult = await runGit(repoDir, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"], signal);
  if (headResult.exitCode !== 0) throw new BranchDiffGitError("unable to resolve the current commit for branch diff");
  const mergeBaseResult = await runGit(repoDir, ["merge-base", baseOid, headResult.stdout.trim()], signal);
  if (mergeBaseResult.exitCode !== 0) throw new BranchDiffGitError("unable to resolve the branch diff merge-base");
  const mergeBase = mergeBaseResult.stdout.trim();
  const trackedResult = await runGit(repoDir, ["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", mergeBase, "--", "."], signal);
  if (trackedResult.exitCode !== 0) throw new BranchDiffGitError("unable to collect the tracked branch diff");
  const statsByPath = parseGitNumstat(trackedResult.stdout);
  const untrackedResult = await runGit(repoDir, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], signal);
  if (untrackedResult.exitCode !== 0) throw new BranchDiffGitError("unable to enumerate untracked files");
  const untrackedPaths = new Set(untrackedResult.stdout.split("\0").filter((path) => path.length > 0));
  if (untrackedPaths.size > BRANCH_DIFF_GIT_MAX_UNTRACKED_FILES) {
    throw new BranchDiffGitError(`too many untracked files for branch diff (${untrackedPaths.size})`);
  }
  for (const path of untrackedPaths) {
    throwIfCancelled(signal);
    if (statsByPath.has(path)) continue;
    const result = await runGit(repoDir, ["diff", "--no-ext-diff", "--no-index", "--no-renames", "--numstat", "-z", "--", "/dev/null", path], signal);
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new BranchDiffGitError("unable to collect an untracked branch diff");
    statsByPath.set(path, parseFirstGitNumstat(result.stdout));
  }
  let additions = 0;
  let deletions = 0;
  for (const stat of statsByPath.values()) {
    additions += stat.additions;
    deletions += stat.deletions;
  }
  return { additions, deletions, files: statsByPath.size };
}
