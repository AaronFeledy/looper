import { UsageError } from "./args.ts";
import { materialPathsExist, prdDirRelative } from "./material-paths.ts";
import { DEFAULT_STORY_ID_PATTERN, storyIdFromBranch } from "./story-id.ts";
import { comparePhase, type StoryPhase } from "./story-state-files.ts";
import { deriveStoryPhases } from "../engine/story-phases.ts";
import { storyFetchTimeoutMs } from "../config/tunables.ts";

const GIT_TIMEOUT_MS = 5_000;

export type StoryPhaseClaimRuntime = {
  readonly mainBranch: string;
  readonly prdDir?: string;
  readonly storyIdPattern?: string;
  readonly storyIds?: readonly string[];
};

async function gitStdout(
  repoDir: string,
  args: readonly string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
    });
    const [exitCode, stdout] = await Promise.all([child.exited, child.stdout.text()]);
    if (exitCode !== 0) return undefined;
    return stdout;
  } catch {
    // no-excuse-ok: catch -- best-effort git boundary maps every failure to undefined
    return undefined;
  }
}

function gitLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function stripOriginPrefix(ref: string): string {
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
}

/**
 * `implemented` requires at least one commit on HEAD not on origin/<mainBranch>
 * that touches a path outside the PRD dir (per-commit path list via `git log`,
 * not a net tree diff). Unresolvable origin/main → accept.
 */
async function assertImplementedPrecondition(
  repoDir: string,
  mainBranch: string,
  prdDir: string | undefined,
): Promise<void> {
  const mainRef = `origin/${mainBranch}`;
  const mainTip = await gitStdout(repoDir, ["rev-parse", "--verify", mainRef]);
  if (mainTip === undefined) return; // cannot disprove

  // List every path touched by any commit on HEAD not in origin/main — a net
  // `diff --name-only A...B` would miss material commits that later cancel out.
  const log = await gitStdout(repoDir, ["log", "--name-only", "--pretty=format:", `${mainRef}..HEAD`]);
  if (log === undefined) {
    throw new UsageError(
      `cannot claim implemented: failed to list commits on HEAD ahead of ${mainRef}; ensure the repo is healthy and try again`,
    );
  }
  const paths = gitLines(log);
  const prdRel = prdDirRelative(repoDir, prdDir);
  if (!materialPathsExist(paths, prdRel)) {
    throw new UsageError(
      `cannot claim implemented: no commits on HEAD ahead of ${mainRef} touch paths outside the PRD directory` +
        (prdRel !== undefined ? ` (${prdRel})` : "") +
        "; commit material work first",
    );
  }
}

async function listStoryRefs(
  repoDir: string,
  storyId: string,
  pattern: string | undefined,
  storyIds: readonly string[] | undefined,
): Promise<{ readonly localOrRemote: string[]; readonly remote: string[] }> {
  const refsOut = await gitStdout(repoDir, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes/origin",
  ]);
  if (refsOut === undefined) return { localOrRemote: [], remote: [] };
  const localOrRemote: string[] = [];
  const remote: string[] = [];
  const effectivePattern = pattern ?? DEFAULT_STORY_ID_PATTERN;
  for (const ref of gitLines(refsOut)) {
    const nameForId = stripOriginPrefix(ref);
    const id = storyIdFromBranch(nameForId, effectivePattern, storyIds ?? [storyId]);
    if (id !== storyId) continue;
    localOrRemote.push(ref);
    if (ref.startsWith("origin/")) remote.push(ref);
  }
  return { localOrRemote, remote };
}

/** `published`: a story branch must exist under refs/remotes/origin/. */
async function assertPublishedPrecondition(
  repoDir: string,
  storyId: string,
  runtime: StoryPhaseClaimRuntime,
): Promise<void> {
  const { remote } = await listStoryRefs(repoDir, storyId, runtime.storyIdPattern, runtime.storyIds);
  if (remote.length === 0) {
    throw new UsageError(
      `cannot claim published for ${storyId}: no branch for this story under refs/remotes/origin/; push the branch first`,
    );
  }
}

/**
 * `merged`: best-effort fetch, then a story branch tip must be an ancestor of
 * origin/<mainBranch>. No branch found → accept (cannot disprove). Found and
 * not ancestor → reject.
 */
async function assertMergedPrecondition(
  repoDir: string,
  storyId: string,
  runtime: StoryPhaseClaimRuntime,
): Promise<void> {
  // Best-effort fetch (same spirit as createStoryPhaseResolver.fetchMain).
  // LOOPER_STORY_FETCH_TIMEOUT_MS including 0 is honored (0 skips fetch).
  const fetchMs = storyFetchTimeoutMs();
  if (fetchMs > 0) {
    await gitStdout(repoDir, ["fetch", "origin", runtime.mainBranch], fetchMs);
  }

  const { localOrRemote } = await listStoryRefs(repoDir, storyId, runtime.storyIdPattern, runtime.storyIds);
  if (localOrRemote.length === 0) return; // cannot disprove

  const mainRef = `origin/${runtime.mainBranch}`;
  for (const tip of localOrRemote) {
    const result = await gitStdout(repoDir, ["merge-base", "--is-ancestor", tip, mainRef]);
    if (result !== undefined) return; // tip is ancestor → merged
  }
  throw new UsageError(
    `cannot claim merged for ${storyId}: story branch tip is not an ancestor of ${mainRef}; merge (or re-fetch) first`,
  );
}

async function assertDerivedNonRegression(
  repoDir: string,
  storyId: string,
  requested: StoryPhase,
  runtime: StoryPhaseClaimRuntime,
): Promise<void> {
  let derived: Readonly<Record<string, StoryPhase>> = {};
  try {
    derived = deriveStoryPhases({
      repoDir,
      storyIds: runtime.storyIds !== undefined && runtime.storyIds.length > 0 ? runtime.storyIds : [storyId],
      mainBranch: runtime.mainBranch,
      ...(runtime.storyIdPattern !== undefined ? { storyIdPattern: runtime.storyIdPattern } : {}),
    });
  } catch {
    // no-excuse-ok: catch -- derive failure is fail-open (no derived ceiling)
    return;
  }
  const floor = derived[storyId];
  if (floor === undefined) return;
  if (comparePhase(requested, floor) < 0) {
    throw new UsageError(
      `cannot set phase to ${requested} for ${storyId}: derived phase from git is ${floor} (will not regress below derived)`,
    );
  }
}

export async function assertStoryPhasePreconditions(
  repoDir: string,
  storyId: string,
  phase: StoryPhase,
  runtime: StoryPhaseClaimRuntime,
): Promise<void> {
  await assertDerivedNonRegression(repoDir, storyId, phase, runtime);

  switch (phase) {
    case "building":
    case "reviewed":
    case "verified":
      return;
    case "implemented":
      await assertImplementedPrecondition(repoDir, runtime.mainBranch, runtime.prdDir);
      return;
    case "published":
      await assertPublishedPrecondition(repoDir, storyId, runtime);
      return;
    case "merged":
      await assertMergedPrecondition(repoDir, storyId, runtime);
      return;
  }
}
