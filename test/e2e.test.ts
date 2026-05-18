import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "..");
const LOOPER_BIN = join(REPO_ROOT, "bin", "looper");
const MAIN_ENTRY = join(REPO_ROOT, "src", "main.ts");
const TMP_ROOT = join(import.meta.dir, ".tmp");
const SCRATCH = join(TMP_ROOT, `e2e-${process.pid}-${Date.now()}`);
const CONFIG_DIR = join(SCRATCH, ".local", "looper");

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode";
const MODEL = process.env.LOOPER_E2E_MODEL ?? "openai/gpt-5.5";
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = spawn({ cmd: ["which", cmd], stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
});

afterAll(() => {
  if (process.env.LOOPER_E2E_KEEP) return;
  rmSync(SCRATCH, { recursive: true, force: true });
});

const itHasOpencode = await commandExists(OPENCODE_BIN);

test.skipIf(!itHasOpencode)(
  "runs two cheap steps against a real OpenCode server and stops cleanly via .looper-stop",
  async () => {
    const markerPromptPath = join(CONFIG_DIR, "marker.md");
    writeFileSync(
      markerPromptPath,
      [
        "Create one file in the current working directory using any available file-writing tool",
        "(such as `apply_patch`, `write`, or the equivalent):",
        "  - Path: `marker.txt`",
        "  - Exact content: `hello` (no trailing newline)",
        "Then stop.",
        "",
      ].join("\n"),
    );

    const stopPromptPath = join(CONFIG_DIR, "stop.md");
    writeFileSync(
      stopPromptPath,
      [
        "Create two files in the current working directory using any available file-writing tool",
        "(such as `apply_patch`, `write`, or the equivalent):",
        "  1. Path: `done.txt`   Exact content: `ok` (no trailing newline)",
        "  2. Path: `.local/looper/.looper-stop`   Exact content: `e2e done` (no trailing newline)",
        "Then stop.",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(CONFIG_DIR, "looper.yaml"),
      [
        "steps:",
        "  marker:",
        "    name: Marker",
        "    agent: build",
        `    model: ${MODEL}`,
        "    variant: low",
        `    prompt: ${markerPromptPath}`,
        "  stop:",
        "    name: Stop",
        "    agent: build",
        `    model: ${MODEL}`,
        "    variant: low",
        `    prompt: ${stopPromptPath}`,
        "",
      ].join("\n"),
    );

    // max iterations = 2 so the 2nd iteration short-circuits on the stop file
    // written by step 2 and the process exits 0 instead of "max iterations reached".
    const proc = spawn({
      cmd: ["bun", MAIN_ENTRY, "--start", "2"],
      cwd: SCRATCH,
      env: { ...process.env, OPENCODE_BIN, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const drainStdout = (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutChunks.push(decoder.decode(value));
      }
    })();
    const drainStderr = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrChunks.push(decoder.decode(value));
      }
    })();

    const exitCode = await proc.exited;
    await Promise.all([drainStdout, drainStderr]);

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    try {
      expect(exitCode).toBe(0);

      const marker = join(SCRATCH, "marker.txt");
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8").trim()).toBe("hello");

      const done = join(SCRATCH, "done.txt");
      expect(existsSync(done)).toBe(true);
      expect(readFileSync(done, "utf8").trim()).toBe("ok");

      const stopFile = join(CONFIG_DIR, ".looper-stop");
      expect(existsSync(stopFile)).toBe(true);
      expect(readFileSync(stopFile, "utf8")).toContain("e2e done");

      expect(stdout).toContain("Marker");
      expect(stdout).toContain("Stop");
    } catch (error) {
      console.error(`looper exited with code ${exitCode}`);
      console.error("--- stdout ---\n" + stdout);
      console.error("--- stderr ---\n" + stderr);
      throw error;
    }
  },
  TEST_TIMEOUT_MS,
);

test("bin wrapper resolves through symlinks and prints help", async () => {
  const proc = spawn({
    cmd: [LOOPER_BIN, "--help"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);
  expect(out).toContain("Looper - iterative OpenCode step runner");
  expect(out).toContain(".local/looper/looper.yaml");
});

test("fails fast with exit 2 when no config is present, and auto-creates the config dir", async () => {
  const emptyDir = join(SCRATCH, "empty");
  mkdirSync(emptyDir, { recursive: true });
  const proc = spawn({
    cmd: ["bun", MAIN_ENTRY, "--start"],
    cwd: emptyDir,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  expect(exitCode).toBe(2);
  expect(err).toContain("missing looper.yaml");
  expect(existsSync(join(emptyDir, ".local", "looper"))).toBe(true);
});
