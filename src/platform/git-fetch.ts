/** Best-effort fetch with no terminal interaction and a bound on the entire process group. */
export async function fetchGitMain(repoDir: string, mainBranch: string, timeoutMs: number): Promise<void> {
  try {
    const child = Bun.spawn(["git", "fetch", "origin", mainBranch], {
      cwd: repoDir,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        child.exited,
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Git may leave an SSH/credential helper behind, or ignore SIGTERM itself.
      // Kill the private group even if its leader exited before the deadline.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
      await child.exited;
    }
  } catch {
    // no-excuse-ok: catch -- an unavailable remote must never block story processing
  }
}
