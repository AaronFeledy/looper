import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let root: string;
beforeEach(() => {
  const scratch = join(import.meta.dir, ".tmp");
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "story-fetch-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
async function fetchMain(timeoutMs: number) {
  const source = join(import.meta.dir, "../src/engine/story-phases.ts");
  const script = `import { createStoryPhaseResolver } from ${JSON.stringify(source)};
    await createStoryPhaseResolver({ repoDir: ${JSON.stringify(root)}, prdIndex: "unused",
      storyState: { readPhase: () => undefined }, storyFetchTimeoutMs: ${timeoutMs} }).fetchMain();`;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, GIT_TERMINAL_PROMPT: "1" } });
  const [code, stderr] = await Promise.all([child.exited, child.stderr.text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
}
function fakeGit(script: string) {
  writeFileSync(join(root, "git"), `#!/bin/bash\n${script}\n`, { mode: 0o700 });
}

test("background fetch disables credential prompts and has no terminal", async () => {
  fakeGit('printf "%s" "$GIT_TERMINAL_PROMPT" > prompt-policy; if (exec 3<>/dev/tty) 2>/dev/null; then touch has-terminal; fi');
  await fetchMain(2000);
  expect(readFileSync(join(root, "prompt-policy"), "utf8")).toBe("0");
  expect(existsSync(join(root, "has-terminal"))).toBe(false);
});

test("fetch timeout kills an uncooperative process and its descendants", async () => {
  fakeGit('trap "" TERM; (sleep 1; printf leaked > late-write) & wait');
  const startedAt = Date.now();
  await fetchMain(100);
  expect(Date.now() - startedAt).toBeLessThan(800);
  await Bun.sleep(1100);
  expect(existsSync(join(root, "late-write"))).toBe(false);
});
