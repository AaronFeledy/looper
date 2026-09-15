export const DEFAULT_STORY_ID_PATTERN = "^([a-z]+-[0-9]+[a-z]?)-";
const GIT_BRANCH_TIMEOUT_MS = 2_000;

export function storyIdFromBranch(branch: string, pattern = DEFAULT_STORY_ID_PATTERN, storyIds?: readonly string[]): string | undefined {
  // Prefer the longest complete PRD ID; split IDs need not fit the fallback regex.
  const lowerBranch = branch.toLowerCase();
  const knownId = storyIds
    ?.filter((id) => id.length > 0 && lowerBranch.startsWith(`${id.toLowerCase()}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (knownId !== undefined) return knownId;
  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const captured = expression.exec(branch)?.[1]?.toUpperCase();
  if (captured === undefined) return undefined;
  // With a PRD id list, only those ids count — a regex-only capture must not
  // impersonate a story (outcome/setsPhase would otherwise hit story.next).
  if (storyIds === undefined) return captured;
  return storyIds.find((id) => id.toUpperCase() === captured);
}

export async function currentGitBranch(repoDir: string): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_BRANCH_TIMEOUT_MS,
    });
    const [exitCode, stdout] = await Promise.all([child.exited, child.stdout.text()]);
    if (exitCode !== 0) return undefined;
    const branch = stdout.trim();
    return branch.length === 0 || branch === "HEAD" ? undefined : branch;
  } catch {
    // no-excuse-ok: catch -- this best-effort process boundary maps every spawn/read failure to undefined by contract
    return undefined;
  }
}
