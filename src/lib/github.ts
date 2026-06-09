import { $ } from "bun";

import type { GithubBugbot, GithubStatus } from "./state.ts";

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
type CheckClass = "pass" | "fail" | "pending" | "neutral";

/** Aggregated CI rollup across every check attached to a PR's head commit. */
export type CiRollup = {
  overall: "none" | "pending" | "passing" | "failing" | "neutral";
  passing: number;
  failing: number;
  pending: number;
  /** Checks whose conclusion is NEUTRAL; counted apart from passing. */
  neutral: number;
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
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
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
  } catch (error) {
    debugGithub(`remote URL parse failed for ${JSON.stringify(trimmed)}: ${formatError(error)}`);
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
  if (conclusion === "NEUTRAL") return "neutral"; // ran, no decision — surfaced apart from passing
  if (conclusion === "SUCCESS" || conclusion === "SKIPPED") return "pass";
  return "fail"; // FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE, STALE
}

/**
 * Reduce a PR's status-check rollup to a single overall verdict plus counts.
 *
 * Precedence for `overall`: any failure → `failing`; else any pending →
 * `pending`; else any passing → `passing`; else any neutral → `neutral`; else
 * `none`. NEUTRAL checks are counted in their own bucket so the UI can show
 * them apart from clean passes (they ran but reached no pass/fail decision).
 */
export function computeCiRollup(entries: StatusCheckRollupEntry[]): CiRollup {
  let passing = 0;
  let failing = 0;
  let pending = 0;
  let neutral = 0;
  for (const entry of entries) {
    const verdict = classifyCheck(entry);
    if (verdict === "pass") passing += 1;
    else if (verdict === "fail") failing += 1;
    else if (verdict === "neutral") neutral += 1;
    else pending += 1;
  }
  const total = passing + failing + pending + neutral;
  const overall =
    failing > 0
      ? "failing"
      : pending > 0
        ? "pending"
        : passing > 0
          ? "passing"
          : neutral > 0
            ? "neutral"
            : "none";
  return { overall, passing, failing, pending, neutral, total };
}

/**
 * Cursor Bugbot publishes a check run named "Cursor Bugbot" whose `detailsUrl`
 * points at cursor.com. Match on either signal so a rename of one doesn't lose
 * detection.
 */
export function isBugbotEntry(entry: StatusCheckRollupEntry): boolean {
  const label = (entry.name || entry.context || "").toLowerCase();
  if (label.includes("bugbot")) return true;
  const url = (entry.detailsUrl ?? "").toLowerCase();
  return url.includes("bugbot") || url.includes("cursor.com");
}

/**
 * Classify a Bugbot check into a {@link GithubBugbot} state. Unlike CI checks,
 * a NEUTRAL conclusion is meaningful here: Bugbot reports "found issues" by
 * concluding NEUTRAL, so we surface it as `issues` rather than folding it into
 * a pass.
 */
export function classifyBugbot(entry: StatusCheckRollupEntry): GithubBugbot["state"] {
  // Legacy status-context shape (state only).
  if (entry.__typename === "StatusContext" || (entry.state !== undefined && entry.status === undefined)) {
    const state = (entry.state ?? "").toUpperCase();
    if (state === "SUCCESS") return "clean";
    if (state === "FAILURE" || state === "ERROR") return "error";
    return "pending";
  }
  const status = (entry.status ?? "").toUpperCase();
  if (status !== "COMPLETED") return "pending";
  const conclusion = (entry.conclusion ?? "").toUpperCase();
  if (conclusion === "NEUTRAL") return "issues";
  if (conclusion === "SUCCESS" || conclusion === "SKIPPED") return "clean";
  if (conclusion === "") return "pending";
  return "error";
}

/**
 * Split a status-check rollup into the most-recent Bugbot entry, if any, and
 * the remaining CI checks. Bugbot is removed from the CI set so it never
 * inflates the pass/fail/neutral counts shown for ordinary CI. When a PR
 * carries more than one Bugbot entry (re-runs), the one with the latest
 * `completedAt`/`startedAt` wins; entries without a timestamp fall back to
 * array order (last seen).
 */
export function partitionBugbot(entries: StatusCheckRollupEntry[]): {
  bugbot: StatusCheckRollupEntry | null;
  ci: StatusCheckRollupEntry[];
} {
  let bugbot: StatusCheckRollupEntry | null = null;
  const ci: StatusCheckRollupEntry[] = [];
  for (const entry of entries) {
    if (!isBugbotEntry(entry)) {
      ci.push(entry);
      continue;
    }
    // Keep the most recent Bugbot run. `>=` makes a later array entry win on a
    // timestamp tie, preserving the prior "last seen" behavior when neither
    // entry carries a usable timestamp (both rank NEGATIVE_INFINITY).
    if (bugbot === null || bugbotEntryTime(entry) >= bugbotEntryTime(bugbot)) {
      bugbot = entry;
    }
  }
  return { bugbot, ci };
}

/**
 * Sortable timestamp for a Bugbot entry, preferring `completedAt` over
 * `startedAt`. Returns NEGATIVE_INFINITY when no parseable timestamp is present
 * so timestamped runs always outrank untimestamped ones.
 */
function bugbotEntryTime(entry: StatusCheckRollupEntry): number {
  const raw = entry.completedAt ?? entry.startedAt;
  if (raw === undefined || raw === "") return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

async function gitOriginUrl(repoDir: string): Promise<string | null> {
  const result = await $`git remote get-url origin`.cwd(repoDir).quiet().nothrow();
  if (result.exitCode !== 0) return null;
  const url = result.stdout.toString().trim();
  return url.length > 0 ? url : null;
}

let ghAvailableCache: Promise<boolean> | undefined;

/** Whether the `gh` CLI is installed and runnable. Cached for the session to avoid repeated subprocess probes. */
export function ghAvailable(): Promise<boolean> {
  if (ghAvailableCache === undefined) {
    ghAvailableCache = $`gh --version`
      .quiet()
      .nothrow()
      .then((result) => {
        if (result.exitCode !== 0) {
          debugGithub(`gh --version exited ${result.exitCode}: ${firstLine(result.stderr.toString()) || "no stderr"}`);
          return false;
        }
        return true;
      })
      .catch((error) => {
        debugGithub(`gh --version threw: ${formatError(error)}`);
        return false;
      });
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

function debugGithub(message: string): void {
  if (process.env.LOOPER_DEBUG_EVENTS === "1") console.error(`[looper] github: ${message}`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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
  } catch (error) {
    debugGithub(`gh ${args.join(" ")} threw: ${formatError(error)}`);
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
  } catch (error) {
    debugGithub(`gh pr list returned invalid JSON: ${formatError(error)}; stdout=${JSON.stringify(firstLine(stdout))}`);
    return { kind: "error", message: "invalid gh output" };
  }

  if (!Array.isArray(data) || data.length === 0) {
    return { kind: "no-pr" };
  }

  const pr = data[0]!;
  if (typeof pr.number !== "number") {
    return { kind: "no-pr" };
  }

  const { bugbot, ci: ciEntries } = partitionBugbot(pr.statusCheckRollup ?? []);
  const ci = computeCiRollup(ciEntries);
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
      ciNeutral: ci.neutral,
      ciTotal: ci.total,
      ...(bugbot !== null ? { bugbot: { state: classifyBugbot(bugbot) } } : {}),
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

  const status = parsePrListJson(result.stdout);

  // Only pay for the extra review-thread query when Bugbot actually found
  // issues; a clean / pending / errored Bugbot run has nothing to count.
  if (status.kind === "pr" && status.pr.bugbot?.state === "issues") {
    const target = parsePrUrl(status.pr.url);
    if (target !== null) {
      const unresolved = await fetchBugbotUnresolved(repoDir, target, withTimeout(signal, GH_TIMEOUT_MS));
      if (unresolved !== null) {
        // Bugbot's check run can linger on NEUTRAL after every thread it opened
        // has been resolved by a human. Zero open threads means nothing is
        // actionable, so report `clean` rather than a stale "issues" line.
        if (unresolved === 0) {
          status.pr.bugbot.state = "clean";
          delete status.pr.bugbot.unresolved;
        } else {
          status.pr.bugbot.unresolved = unresolved;
        }
      }
    }
  }

  return status;
}

/** Parse `owner`, `repo`, and PR `number` out of a github.com PR URL. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (match === null) return null;
  const number = Number(match[3]);
  if (!Number.isInteger(number)) return null;
  return { owner: match[1]!, repo: match[2]!, number };
}

/**
 * True when a review-comment author login belongs to Cursor Bugbot. The bot
 * posts as `cursor` (GraphQL) / `cursor[bot]` (REST); match either form.
 */
export function isBugbotLogin(login: string): boolean {
  const normalized = login.toLowerCase();
  return normalized === "cursor" || normalized === "cursor[bot]";
}

type ReviewThreadsGraphql = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: ({
            isResolved?: boolean;
            comments?: { nodes?: ({ author?: { login?: string } | null } | null)[] | null } | null;
          } | null)[] | null;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
        } | null;
      } | null;
    } | null;
  } | null;
};

/** One parsed page of the review-thread query: a count plus pagination info. */
export type BugbotThreadsPage = {
  /** Unresolved Bugbot-authored threads on this page. */
  count: number;
  /** Whether more thread pages remain to fetch. */
  hasNextPage: boolean;
  /** Cursor to pass as `after` for the next page; null when none. */
  endCursor: string | null;
};

/**
 * Parse one page of the `reviewThreads` GraphQL payload: count the unresolved
 * threads opened by Bugbot (not resolved, first comment authored by Bugbot)
 * and extract pagination info. Returns `null` on malformed input.
 */
export function parseBugbotThreadsPage(stdout: string): BugbotThreadsPage | null {
  let data: ReviewThreadsGraphql;
  try {
    data = JSON.parse(stdout) as ReviewThreadsGraphql;
  } catch (error) {
    debugGithub(`gh api graphql returned invalid JSON: ${formatError(error)}; stdout=${JSON.stringify(firstLine(stdout))}`);
    return null;
  }
  const threads = data.data?.repository?.pullRequest?.reviewThreads;
  const nodes = threads?.nodes;
  if (!Array.isArray(nodes)) return null;
  let count = 0;
  for (const thread of nodes) {
    if (thread == null || thread.isResolved === true) continue;
    const login = thread.comments?.nodes?.[0]?.author?.login ?? "";
    if (isBugbotLogin(login)) count += 1;
  }
  return {
    count,
    hasNextPage: threads?.pageInfo?.hasNextPage === true,
    endCursor: threads?.pageInfo?.endCursor ?? null,
  };
}

/**
 * Count the unresolved Bugbot threads in a single (unpaginated) `reviewThreads`
 * payload. Returns `null` on malformed input.
 */
export function countUnresolvedBugbotThreads(stdout: string): number | null {
  const page = parseBugbotThreadsPage(stdout);
  return page === null ? null : page.count;
}

const BUGBOT_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          isResolved
          comments(first: 1) { nodes { author { login } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** Page ceiling for review-thread pagination (100 threads/page = 5000 max). */
const BUGBOT_THREADS_MAX_PAGES = 50;

/**
 * Query the PR's review threads and return how many unresolved ones Bugbot
 * raised, paginating through every page so PRs with more than 100 threads are
 * counted fully (a partial count could otherwise flip Bugbot from `issues` to
 * `clean`). Returns `null` if `gh` fails or returns unparseable output so the
 * caller can render Bugbot's state without a count rather than erroring. The
 * shared `signal` bounds the whole pagination loop, not each page.
 */
async function fetchBugbotUnresolved(
  repoDir: string,
  target: { owner: string; repo: string; number: number },
  signal: AbortSignal,
): Promise<number | null> {
  let total = 0;
  let after: string | null = null;
  for (let page = 0; page < BUGBOT_THREADS_MAX_PAGES; page += 1) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${BUGBOT_THREADS_QUERY}`,
      "-F",
      `owner=${target.owner}`,
      "-F",
      `repo=${target.repo}`,
      "-F",
      `number=${target.number}`,
    ];
    // Cursor is an opaque string; pass it raw (`-f`) so gh doesn't coerce it.
    if (after !== null) args.push("-f", `after=${after}`);
    const result = await runGh(args, repoDir, signal);
    if (result === null) return null;
    if (result.exitCode !== 0) {
      debugGithub(`gh ${args.join(" ")} exited ${result.exitCode}: ${firstLine(result.stderr) || "no stderr"}`);
      return null;
    }
    const parsed = parseBugbotThreadsPage(result.stdout);
    if (parsed === null) return null;
    total += parsed.count;
    if (!parsed.hasNextPage || parsed.endCursor === null) return total;
    after = parsed.endCursor;
  }
  return total;
}
