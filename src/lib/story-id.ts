const DEFAULT_STORY_ID_PATTERN = "^([a-z]+-[0-9]+)-";
const GIT_BRANCH_TIMEOUT_MS = 2_000;

export function storyIdFromBranch(branch: string, pattern = DEFAULT_STORY_ID_PATTERN): string | undefined {
  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return expression.exec(branch)?.[1]?.toUpperCase();
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
