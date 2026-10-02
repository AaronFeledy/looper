import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let root: string;
let configDir: string;
let prdDir: string;
beforeEach(() => {
  const scratch = join(import.meta.dir, ".tmp"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "prd-cli-"));
  configDir = join(root, "config"); prdDir = join(root, "prd");
  mkdirSync(configDir); mkdirSync(prdDir);
  writeFileSync(join(prdDir, "prd.json"), '{"userStories":[{"id":"US-1"}]}');
  writeFileSync(join(configDir, "looper.yml"), `prd: ${prdDir}\nsteps:\n  build:\n    prompt: work.md\n`);
  writeFileSync(join(configDir, "work.md"), "test");
  writeFileSync(join(configDir, ".looper-story-state.json"), "legacy phases");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function runCli(args: readonly string[], tty = false) {
  const command = [process.execPath, join(import.meta.dir, "../src/main.ts"), `--config-dir=${configDir}`, ...args];
  const child = Bun.spawn(tty ? ["script", "-qec", command.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" "), "/dev/null"] : command, {
    cwd: root, stdin: tty ? new Blob(["\n"]) : "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, XDG_CONFIG_HOME: join(root, "xdg"), LOOPER_REPO_DIR: root, OPENCODE_BIN: join(root, "missing-opencode") },
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
}

test("non-TTY fresh cannot erase unassociated PRD state", async () => {
  // Given legacy state; When the real CLI starts fresh unattended.
  const result = await runCli(["--start", "--fresh", "--reset-stories"]);
  // Then it stops before fresh deletion or server startup.
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("--adopt-prd-state");
  expect(readFileSync(join(configDir, ".looper-story-state.json"), "utf8")).toBe("legacy phases");
});

test("TTY cancellation preserves legacy state before renderer startup", async () => {
  // Given a terminal and legacy state; When Enter declines association.
  const result = await runCli(["--fresh", "--start"], true);
  // Then no fresh deletion or alternate-screen entry occurs.
  expect(result.code).not.toBe(0);
  expect(result.output).not.toContain("\x1b[?1049h");
  expect(readFileSync(join(configDir, ".looper-story-state.json"), "utf8")).toBe("legacy phases");
});

test("explicit CLI reset archives state before attempting server startup", async () => {
  // Given legacy state; When the operator explicitly resets it.
  const result = await runCli(["--start", "--reset-prd-state", "--confirm-legacy-stopped"]);
  // Then protection completed even though the test intentionally has no OpenCode binary.
  const archives = readdirSync(join(configDir, ".looper-archive"));
  expect(archives).toHaveLength(1);
  expect(result.code).not.toBe(0);
  expect(readdirSync(configDir)).not.toContain(".looper-story-state.json");
  expect(JSON.parse(readFileSync(join(configDir, ".looper-prd-identity.json"), "utf8")).prdDir).toBe(prdDir);
});
