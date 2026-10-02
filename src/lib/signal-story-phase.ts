import { UsageError } from "./args.ts";
import { materialPathsExist, prdDirRelative } from "./material-paths.ts";
import { DEFAULT_STORY_ID_PATTERN, storyIdFromBranch } from "./story-id.ts";
import { type StoryPhase } from "./story-state-files.ts";

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

async function listRemoteStoryRefs(
  repoDir: string,
  storyId: string,
  pattern: string | undefined,
  storyIds: readonly string[] | undefined,
): Promise<string[]> {
  const prefix = "refs/remotes/origin/";
  const refsOut = await gitStdout(repoDir, ["for-each-ref", "--format=%(refname)", prefix]);
  if (refsOut === undefined) return [];
  const remote: string[] = [];
  const effectivePattern = pattern ?? DEFAULT_STORY_ID_PATTERN;
  for (const ref of gitLines(refsOut)) {
    if (!ref.startsWith(prefix)) continue;
    const id = storyIdFromBranch(ref.slice(prefix.length), effectivePattern, storyIds ?? [storyId]);
    if (id === storyId) remote.push(ref);
  }
  return remote;
}

/** `published`: a story branch must exist under refs/remotes/origin/. */
async function assertPublishedPrecondition(
  repoDir: string,
  storyId: string,
  runtime: StoryPhaseClaimRuntime,
): Promise<void> {
  const remote = await listRemoteStoryRefs(repoDir, storyId, runtime.storyIdPattern, runtime.storyIds);
  if (remote.length === 0) {
    throw new UsageError(
      `cannot claim published for ${storyId}: no branch for this story under refs/remotes/origin/; push the branch first`,
    );
  }
}

export async function assertStoryPhasePreconditions(
  repoDir: string,
  storyId: string,
  phase: StoryPhase,
  runtime: StoryPhaseClaimRuntime,
): Promise<void> {
  // Only EXISTENCE checks live here. `implemented` asks "is there a commit?" and
  // `published` asks "is there a remote branch?" -- both are facts a ref either
  // has or does not have. There is deliberately no `merged` check: every test
  // for it reconstructs history from ref topology, which is lossy, and a lossy
  // validator rejects TRUE claims (a squash-merged story could not be signalled
  // merged at all, by the loop or by hand). Babysit calls this immediately after
  // `gh pr merge` returns 0, so it is the authority; second-guessing it with
  // worse information only ever loses. `building`/`reviewed`/`verified` are
  // loop-internal and were always taken on trust.
  switch (phase) {
    case "building":
    case "reviewed":
    case "verified":
    case "merged":
      return;
    case "implemented":
      await assertImplementedPrecondition(repoDir, runtime.mainBranch, runtime.prdDir);
      return;
    case "published":
      await assertPublishedPrecondition(repoDir, storyId, runtime);
      return;
  }
}
