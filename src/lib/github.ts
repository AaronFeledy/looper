import { $ } from "bun";

import type { GithubStatus } from "./state.ts";

/**
 * GitHub PR/CI integration.
 *
 * Detection is intentionally cheap and dependency-free: we read the `origin`
 * remote with plain git and shell out to the `gh` CLI for PR/CI data so we
 * inherit the user's existing `gh` auth without managing tokens ourselves.
 * Every entry point degrades gracefully — a missing `gh`, an unauthenticated
 * session, or a non-GitHub remote simply disables the feature rather than
 * erroring.
 */

/** Outcome of classifying a single status-check entry. */
type CheckClass = "pass" | "fail" | "pending";

/** Aggregated CI rollup across every check attached to a PR's head commit. */
export type CiRollup = {
  overall: "none" | "pending" | "passing" | "failing";
  passing: number;
  failing: number;
  pending: number;
  total: number;
};

/**
 * A single status-check entry from the `statusCheckRollup` array. The array
 * mixes two GraphQL shapes:
 * - `CheckRun` (GitHub Actions / app check runs): `status` + `conclusion`
 * - `StatusContext` (legacy commit statuses): `state`
 */
export type StatusCheckRollupEntry = {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  context?: string;
};

type GhPrJson = {
  number?: number;
  title?: string;
  state?: string;
  isDraft?: boolean;
  url?: string;
  statusCheckRollup?: StatusCheckRollupEntry[] | null;
};

/**
 * Return true when a git remote URL points at github.com.
 *
 * Handles the three forms git emits:
 * - scp-like:  `git@github.com:owner/repo.git`
 * - https:     `https://github.com/owner/repo.git`
 * - ssh url:   `ssh://git@github.com/owner/repo.git`
 *
 * GitHub Enterprise hosts are intentionally excluded; this targets github.com.
 */
export function parseRemoteIsGithub(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return false;

  // scp-like syntax (`user@host:path`) is not a valid URL, so match it first.
  const scp = /^[^/@]+@([^:/]+):/.exec(trimmed);
  if (scp) return isGithubHost(scp[1]!);

  try {
    return isGithubHost(new URL(trimmed).hostname);
  } catch {
    return false;
  }
}

function isGithubHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "github.com" || normalized === "www.github.com";
}

function classifyCheck(entry: StatusCheckRollupEntry): CheckClass {
  // Legacy commit statuses carry a `state`; check runs carry `status`/`conclusion`.
  if (entry.__typename === "StatusContext" || (entry.state !== undefined && entry.status === undefined)) {
    const state = (entry.state ?? "").toUpperCase();
    if (state === "SUCCESS") return "pass";
    if (state === "FAILURE" || state === "ERROR") return "fail";
    return "pending"; // EXPECTED, PENDING, ""
  }

  const status = (entry.status ?? "").toUpperCase();
  if (status !== "COMPLETED") return "pending"; // QUEUED, IN_PROGRESS, WAITING, PENDING, REQUESTED
  const conclusion = (entry.conclusion ?? "").toUpperCase();
  if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") return "pass";
  return "fail"; // FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE, STALE
}

/**
 * Reduce a PR's status-check rollup to a single overall verdict plus counts.
 *
 * Precedence for `overall`: any failure → `failing`; else any pending →
 * `pending`; else at least one check → `passing`; else `none`.
 */
export function computeCiRollup(entries: StatusCheckRollupEntry[]): CiRollup {
  let passing = 0;
  let failing = 0;
  let pending = 0;
  for (const entry of entries) {
    const verdict = classifyCheck(entry);
    if (verdict === "pass") passing += 1;
    else if (verdict === "fail") failing += 1;
    else pending += 1;
  }
  const total = passing + failing + pending;
  const overall = failing > 0 ? "failing" : pending > 0 ? "pending" : total > 0 ? "passing" : "none";
  return { overall, passing, failing, pending, total };
}

async function gitOriginUrl(repoDir: string): Promise<string | null> {
  const result = await $`git remote get-url origin`.cwd(repoDir).quiet().nothrow();
  if (result.exitCode !== 0) return null;
  const url = result.stdout.toString().trim();
  return url.length > 0 ? url : null;
}

let ghAvailableCache: Promise<boolean> | undefined;

/** Whether the `gh` CLI is installed and runnable. Cached for the session. */
export function ghAvailable(): Promise<boolean> {
  if (ghAvailableCache === undefined) {
    ghAvailableCache = $`gh --version`
      .quiet()
      .nothrow()
      .then((result) => result.exitCode === 0)
      .catch(() => false);
  }
  return ghAvailableCache;
}

/**
 * True when the repo's `origin` points at github.com AND the `gh` CLI is
 * available. Used to decide whether to mount the PR status panel at all.
 */
export async function detectGithubRepo(repoDir: string): Promise<boolean> {
  const url = await gitOriginUrl(repoDir);
  if (url === null || !parseRemoteIsGithub(url)) return false;
  return ghAvailable();
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

const GH_TIMEOUT_MS = 10_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function runGh(
  args: string[],
  repoDir: string,
  signal: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
  try {
    const proc = Bun.spawn(["gh", ...args], { cwd: repoDir, stdout: "pipe", stderr: "pipe", signal });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, stdout, stderr };
  } catch {
    return null;
  }
}

/**
 * Map a `gh pr list --json` array payload to a {@link GithubStatus}.
 *
 * Split out from {@link fetchPrStatus} so the JSON-shape handling is unit
 * testable without spawning `gh`. An empty array is the canonical
 * "no PR for this branch" signal — `gh pr list` exits 0 in that case, so we
 * never have to pattern-match human-readable error strings.
 */
export function parsePrListJson(stdout: string): GithubStatus {
  let data: GhPrJson[];
  try {
    data = JSON.parse(stdout) as GhPrJson[];
  } catch {
    return { kind: "error", message: "invalid gh output" };
  }

  if (!Array.isArray(data) || data.length === 0) {
    return { kind: "no-pr" };
  }

  const pr = data[0]!;
  if (typeof pr.number !== "number") {
    return { kind: "no-pr" };
  }

  const ci = computeCiRollup(pr.statusCheckRollup ?? []);
  return {
    kind: "pr",
    pr: {
      number: pr.number,
      title: pr.title ?? "",
      state: (pr.state ?? "").toUpperCase(),
      isDraft: Boolean(pr.isDraft),
      url: pr.url ?? "",
      ciOverall: ci.overall,
      ciPassing: ci.passing,
      ciFailing: ci.failing,
      ciPending: ci.pending,
      ciTotal: ci.total,
    },
  };
}

/**
 * Fetch PR + CI status for `branch` via `gh pr list --head`.
 *
 * Returns a discriminated {@link GithubStatus}:
 * - `no-pr` when the branch is detached/unknown or has no associated PR
 * - `error` when `gh` fails for any other reason (e.g. auth, network)
 * - `pr` with the PR metadata and a computed CI rollup on success
 *
 * `gh pr list --head <branch>` is used rather than `gh pr view <branch>`
 * deliberately: `gh pr view` treats its positional argument as
 * "PR number | URL | branch" in that order, so a branch literally named `42`
 * would silently resolve to PR #42. `--head` matches the head ref name
 * unambiguously and reports "no PR" as an empty array (exit 0) instead of a
 * localized error string. `--state all --limit 1` keeps a recently
 * merged/closed PR visible while preferring the most recent PR for the branch.
 */
export async function fetchPrStatus(repoDir: string, branch: string, signal?: AbortSignal): Promise<GithubStatus> {
  if (branch.length === 0 || branch === "unknown" || branch === "detached") {
    return { kind: "no-pr" };
  }

  const result = await runGh(
    ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,title,state,isDraft,url,statusCheckRollup"],
    repoDir,
    withTimeout(signal, GH_TIMEOUT_MS),
  );

  if (result === null) return { kind: "error", message: "gh pr list failed" };

  if (result.exitCode !== 0) {
    return { kind: "error", message: firstLine(result.stderr) || "gh pr list failed" };
  }

  return parsePrListJson(result.stdout);
}
