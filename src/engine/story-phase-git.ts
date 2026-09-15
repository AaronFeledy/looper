import { type StoryPhase } from "../lib/story-state-files.ts";
import { storyIdFromBranch, DEFAULT_STORY_ID_PATTERN } from "../lib/story-id.ts";

export const DEFAULT_STORY_PHASE_GIT_TIMEOUT_MS = 5_000;

export type DeriveStoryPhasesInput = {
  readonly repoDir: string;
  readonly storyIds: readonly string[];
  readonly mainBranch: string;
  readonly storyIdPattern?: string;
  readonly gitTimeoutMs?: number;
};

export type DeriveStoryPhases = (input: DeriveStoryPhasesInput) => Readonly<Record<string, StoryPhase>>;

function gitStdoutSync(
  repoDir: string,
  args: readonly string[],
  timeoutMs: number,
): string | undefined {
  try {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
    });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.toString();
  } catch {
    // no-excuse-ok: catch -- best-effort git boundary maps every failure to undefined
    return undefined;
  }
}

async function gitStdoutAsync(
  repoDir: string,
  args: readonly string[],
  timeoutMs: number,
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
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

function stripOriginPrefix(ref: string): string {
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
}

function isRemoteOriginRef(ref: string): boolean {
  return ref.startsWith("origin/");
}

/**
 * Derive per-story phase ceilings from git refs (synchronous).
 * - merged: any story branch tip is an ancestor of origin/<mainBranch>
 * - published: any story branch exists under refs/remotes/origin/ (and is not merged)
 * Git failure → empty map (fail open, never throws).
 */
export function deriveStoryPhases(input: DeriveStoryPhasesInput): Readonly<Record<string, StoryPhase>> {
  const timeoutMs = input.gitTimeoutMs ?? DEFAULT_STORY_PHASE_GIT_TIMEOUT_MS;
  const pattern = input.storyIdPattern ?? DEFAULT_STORY_ID_PATTERN;
  const storyIds = input.storyIds;
  if (storyIds.length === 0) return {};

  const refsOut = gitStdoutSync(
    input.repoDir,
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"],
    timeoutMs,
  );
  if (refsOut === undefined) return {};

  const refs = gitLines(refsOut);
  const byStory = new Map<string, { readonly localOrRemote: string[]; readonly remote: string[] }>();
  for (const id of storyIds) byStory.set(id, { localOrRemote: [], remote: [] });

  for (const ref of refs) {
    const nameForId = stripOriginPrefix(ref);
    const storyId = storyIdFromBranch(nameForId, pattern, storyIds);
    if (storyId === undefined) continue;
    const bucket = byStory.get(storyId);
    if (bucket === undefined) continue;
    bucket.localOrRemote.push(ref);
    if (isRemoteOriginRef(ref)) bucket.remote.push(ref);
  }

  const mainRef = `origin/${input.mainBranch}`;
  const derived: Record<string, StoryPhase> = {};

  for (const [storyId, bucket] of byStory) {
    if (bucket.localOrRemote.length === 0) continue;

    let merged = false;
    for (const tip of bucket.localOrRemote) {
      const result = gitStdoutSync(
        input.repoDir,
        ["merge-base", "--is-ancestor", tip, mainRef],
        timeoutMs,
      );
      // merge-base --is-ancestor exits 0 when true; gitStdoutSync returns stdout (possibly "") on 0.
      if (result !== undefined) {
        merged = true;
        break;
      }
    }
    if (merged) {
      derived[storyId] = "merged";
      continue;
    }
    if (bucket.remote.length > 0) {
      derived[storyId] = "published";
    }
  }

  return derived;
}

/** Best-effort `git fetch origin <mainBranch>`. Never throws. */
export async function fetchOriginMain(
  repoDir: string,
  mainBranch: string,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) return;
  await gitStdoutAsync(repoDir, ["fetch", "origin", mainBranch], timeoutMs);
}
