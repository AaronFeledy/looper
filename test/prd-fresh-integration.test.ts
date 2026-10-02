import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/lib/args.ts";
import { protectPrdStartup } from "../src/lib/prd-startup.ts";
import { acquireRunLease } from "../src/persistence/run-lease.ts";
import { createRunStateStore } from "../src/persistence/run-state-store.ts";
import { createStoryStateStore } from "../src/persistence/story-state-store.ts";
import { createStepAttemptStore } from "../src/persistence/step-attempt-store.ts";
import { createAdjudicationStore } from "../src/persistence/adjudication-store.ts";
import { createAgentTrailStore } from "../src/persistence/agent-trail-store.ts";
import { startAgentTrailPersistence } from "../src/lib/agent-trail.ts";
import { createLoopState } from "../src/lib/state.ts";

let root: string;
beforeEach(() => {
  const scratch = join(import.meta.dir, ".tmp"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "fresh-integration-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const deletedFiles = [".looper-run.json", ".looper-resume-step.json", ".looper-agents.json", ".looper-step-attempts.json",
  ".looper-adjudicate", ".looper-adjudicate-session.json", ".looper-phase-history.json", ".looper-adjudication-log.json",
  ".looper-signals.jsonl", ".looper-permission-log.jsonl", ".looper-stop", ".looper-stop-after-iteration"] as const;

function fixture(lateRequest = false) {
  let stepAborts = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/session/step/abort") {
      stepAborts++;
      if (lateRequest && stepAborts === 2) createAdjudicationStore({ configDir: root }).writeMarker("new request during reconciliation");
    }
    if (path.endsWith("/abort")) return Response.json(true);
    if (path === "/session/status") return Response.json({});
    if (path.endsWith("/children")) return Response.json([]);
    return Response.json({}, { status: 404 });
  } });
  const run = createRunStateStore({ configDir: root });
  run.savePosition({ iteration: 1, steps: [{ name: "Build" }], stepIndex: 0, sessionID: "step" });
  run.saveResumeStep([{ name: "Build" }], 0); run.writeStop("old stop"); run.writeStopAfterIteration("old stop");
  createStoryStateStore({ configDir: root }).writePhase("US-1", "reviewed");
  const attempts = createStepAttemptStore({ configDir: root });
  attempts.recordNonAdvance({ storyId: "US-1", stepName: "Build", kind: "blocked" });
  const adjudication = createAdjudicationStore({ configDir: root });
  adjudication.writeMarker("old request"); adjudication.writeSession({ sessionID: "judge" });
  adjudication.appendHistory([{ storyId: "US-1", from: "reviewed", to: "building", iteration: 1, stepName: "Build", at: new Date().toISOString(), source: "signal" }]);
  adjudication.appendCompletion({ at: new Date().toISOString(), reason: "old completion" });
  const trail = createAgentTrailStore(root);
  trail.write([{ sessionID: "done", name: "Build", status: "done", iteration: 1, startedAt: 1, finishedAt: 2, children: [] }]);
  writeFileSync(join(root, ".looper-prd-identity.json"), JSON.stringify({ version: 1, writerProtocol: 1, prdDir: null, serverUrl: server.url.toString() }));
  writeFileSync(join(root, ".looper-signals.jsonl"), "old signal\n");
  writeFileSync(join(root, ".looper-permission-log.jsonl"), "old audit\n");
  writeFileSync(join(root, ".last-branch"), "keep branch");
  writeFileSync(join(root, "looper.yml"), "steps:\n  build:\n    prompt: build.md\n");
  writeFileSync(join(root, "build.md"), "test prompt");
  writeFileSync(join(root, "prd.json"), '{"userStories":[]}');
  return { url: server.url.toString(), run, attempts, adjudication, trail, get stepAborts() { return stepAborts; }, [Symbol.dispose]() { server.stop(true); } };
}

test("full production store cleanup must not reacquire the held writer mutex", async () => {
  // Given the same real stores used by the TTY reset callback.
  using state = fixture(); using ownership = acquireRunLease(root);
  const guard = await protectPrdStartup({ configDir: root, repoDir: root, options: parseArgs([]), interactive: false, ownership });
  // When invoking the production fresh primitive; Then every disk category clears without nested locking.
  await guard.fresh();
  for (const name of deletedFiles) expect(existsSync(join(root, name))).toBe(false);
  expect(state.attempts.read("US-1", "Build")).toBeUndefined();
  expect(state.adjudication.markerExists()).toBe(false);
}, 10_000);

test("post-success trail memory cleanup does not delete newly persisted work", async () => {
  // Given production trail persistence with retained rows and a completed guarded disk reset.
  using state = fixture(); using ownership = acquireRunLease(root);
  const view = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
  const trail = startAgentTrailPersistence(root, () => view);
  try {
    const guard = await protectPrdStartup({ configDir: root, repoDir: root, options: parseArgs([]), interactive: false, ownership });
    await guard.fresh();
    state.trail.write([{ sessionID: "new", name: "Review", status: "done", iteration: 2, children: [] }]);
    state.attempts.recordNonAdvance({ storyId: "US-2", stepName: "Review", kind: "blocked" });
    // When the real TTY memory-only operation runs; Then later disk writes survive it.
    trail.resetMemory();
    expect(view.retainedSteps).toEqual([]);
    expect(state.trail.read().map(entry => entry.sessionID)).toEqual(["new"]);
    expect(state.attempts.read("US-2", "Review")?.count).toBe(1);
  } finally { trail.stop(); }
});

async function runCli(url: string, tty: boolean, resetStories: boolean) {
  const args = [process.execPath, join(import.meta.dir, "../src/main.ts"), `--config-dir=${root}`, `--attach=${url}`, "--start", "--fresh", ...(resetStories ? ["--reset-stories"] : []), "1"];
  const command = args.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
  const child = Bun.spawn(tty ? ["script", "-qefc", command, "/dev/null"] : args, {
    cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, LOOPER_REPO_DIR: root, XDG_CONFIG_HOME: join(root, "xdg") },
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
}

test.each([false, true])("real CLI full fresh cleanup preserves protected files (TTY=%s)", async tty => {
  // Given every production state category, plus configuration and PRD artifacts.
  using state = fixture();
  // When the real frontend starts fresh; Then disk cleanup completes before deliberate server validation failure.
  const result = await runCli(state.url, tty, false);
  expect(result.code).not.toBe(0);
  for (const name of deletedFiles) expect(existsSync(join(root, name))).toBe(false);
  expect(createStoryStateStore({ configDir: root }).readPhase("US-1")).toBe("reviewed");
  for (const name of ["looper.yml", "build.md", "prd.json", ".last-branch", ".looper-prd-identity.json", ".looper-state-lock.sqlite", ".looper-run-lock.sqlite"]) expect(existsSync(join(root, name))).toBe(true);
}, 15_000);

test.each([false, true])("real CLI reset-stories clears phases too (TTY=%s)", async tty => {
  // Given a persisted phase; When the real frontend requests reset-stories.
  using state = fixture();
  await runCli(state.url, tty, true);
  // Then fresh cleanup clears phases, not only checkpoints.
  expect(existsSync(join(root, ".looper-story-state.json"))).toBe(false);
  for (const name of deletedFiles) expect(existsSync(join(root, name))).toBe(false);
}, 15_000);

test.each([false, true])("real immediate fresh preserves all state if a request arrives during final reconciliation (TTY=%s)", async tty => {
  // Given startup preparation followed by a concurrent adjudication request during the final fresh check.
  using state = fixture(true);
  // When immediate fresh is about to delete; Then its original snapshot must still match.
  const result = await runCli(state.url, tty, false);
  expect(result.code).not.toBe(0);
  expect(state.stepAborts).toBe(2);
  for (const name of deletedFiles) expect(existsSync(join(root, name))).toBe(true);
  expect(state.adjudication.readMarker()).toContain("new request during reconciliation");
}, 15_000);

test.each([undefined, "", "   ", 42, null])("rejects malformed owner token before stale PID takeover (%s)", async token => {
  // Given a proven exited process but malformed ownership evidence.
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" }); await child.exited;
  const raw = JSON.stringify({ version: 1, host: hostname(), pid: child.pid, token });
  writeFileSync(join(root, ".looper-run-owner.json"), raw);
  // When acquiring a lease; Then dead PID alone cannot authorize replacing invalid evidence.
  expect(() => { using lease = acquireRunLease(root); }).toThrow("Unknown frontend ownership");
  expect(readFileSync(join(root, ".looper-run-owner.json"), "utf8")).toBe(raw);
});

test("valid owner token allows takeover only after the recorded process exits", async () => {
  // Given valid ownership evidence for an exited process.
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" }); await child.exited;
  writeFileSync(join(root, ".looper-run-owner.json"), JSON.stringify({ version: 1, host: hostname(), pid: child.pid, token: "valid-old-owner" }));
  // When acquiring the lease; Then stale valid ownership does not block normal startup.
  using ownership = acquireRunLease(root);
  expect(() => ownership.assertOwned()).not.toThrow();
});
