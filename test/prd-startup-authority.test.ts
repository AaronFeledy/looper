import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../src/lib/args.ts";
import { protectPrdStartup } from "../src/lib/prd-startup.ts";
import { acquireRunLease } from "../src/persistence/run-lease.ts";

let root: string;
beforeEach(() => {
  const scratch = join(import.meta.dir, ".tmp"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "prd-authority-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function savedWork(url: string) {
  writeFileSync(join(root, ".looper-prd-identity.json"), JSON.stringify({ version: 1, writerProtocol: 1, prdDir: null, serverUrl: url }));
  writeFileSync(join(root, ".looper-run.json"), JSON.stringify({ iteration: 1, stepIndex: 0, stepName: "Build", sessionID: "old", updatedAt: "now" }));
}
const identity = () => JSON.parse(readFileSync(join(root, ".looper-prd-identity.json"), "utf8"));
function serverFixture(unknownChildren = false) {
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    if (path.endsWith("/abort")) return Response.json(true);
    if (path === "/session/status") return Response.json({});
    if (path.endsWith("/children")) return unknownChildren ? Response.json({}, { status: 503 }) : Response.json([]);
    return Response.json({}, { status: 404 });
  } });
  return { url: server.url.toString(), requests, [Symbol.dispose]() { server.stop(true); } };
}

test("same-PRD normal startup reconciles A before authorizing B", async () => {
  // Given saved work on A, with no fresh/reset flag.
  using a = serverFixture(); using b = serverFixture(); using ownership = acquireRunLease(root);
  savedWork(a.url);
  const guard = await protectPrdStartup({ configDir: root, repoDir: root, options: parseArgs([]), interactive: false, ownership });
  // When B passes validation; Then A remains authoritative until its old work stops.
  await guard.acceptServer(b.url, async () => { expect(identity().serverUrl).toBe(a.url); expect(a.requests).toEqual([]); });
  expect(a.requests).toContain("/session/old/abort");
  expect(b.requests).toEqual([]);
  expect(identity().serverUrl).toBe(b.url);
});

test("B's empty status cannot authorize a switch when A cannot enumerate descendants", async () => {
  // Given uncertain child work on A and a healthy replacement B.
  using a = serverFixture(true); using b = serverFixture(); using ownership = acquireRunLease(root);
  savedWork(a.url);
  const guard = await protectPrdStartup({ configDir: root, repoDir: root, options: parseArgs([]), interactive: false, ownership });
  // When accepting B; Then uncertainty preserves A and the checkpoint.
  await expect(guard.acceptServer(b.url, async () => {})).rejects.toThrow("Unknown child work");
  expect(identity().serverUrl).toBe(a.url);
  expect(b.requests).toEqual([]);
  expect(existsSync(join(root, ".looper-run.json"))).toBe(true);
});

test("configured endpoint alone cannot supply missing authority for saved work", async () => {
  // Given saved work without an original endpoint and a newly configured server.
  using b = serverFixture(); using ownership = acquireRunLease(root);
  savedWork(b.url);
  writeFileSync(join(root, ".looper-prd-identity.json"), '{"version":1,"writerProtocol":1,"prdDir":null}');
  const guard = await protectPrdStartup({ configDir: root, repoDir: root, attachUrl: b.url, options: parseArgs([]), interactive: false, ownership });
  // When configuration would silently turn B into the original authority; Then require an explicit original-server choice.
  await expect(guard.acceptServer(b.url, async () => {})).rejects.toThrow("--attach=");
  expect(b.requests).toEqual([]);
  expect(identity().serverUrl).toBeUndefined();
});

test("deferred fresh rechecks work that appeared after launch", async () => {
  // Given a clean launch followed by new checkpoint evidence while waiting for Go.
  using a = serverFixture(true); using ownership = acquireRunLease(root);
  const guard = await protectPrdStartup({ configDir: root, repoDir: root, options: parseArgs(["--fresh"]), interactive: false, ownership });
  savedWork(a.url);
  // When the deferred destructive action is requested; Then failed reconciliation blocks it.
  await expect(guard.fresh()).rejects.toThrow();
  expect(a.requests).toContain("/session/old/abort");
  expect(existsSync(join(root, ".looper-run.json"))).toBe(true);
});

test("deferred fresh clears only after successful reconciliation", async () => {
  // Given old work captured after launch.
  using a = serverFixture(); using ownership = acquireRunLease(root);
  const guard = await protectPrdStartup({ configDir: root, repoDir: root, options: parseArgs([]), interactive: false, ownership });
  savedWork(a.url);
  // When resetting; Then the production disk cleanup runs after confirm-stop.
  await guard.fresh();
  expect(a.requests).toContain("/session/old/abort");
  expect(existsSync(join(root, ".looper-run.json"))).toBe(false);
});

test("authority replacement detects checkpoint changes during validation", async () => {
  // Given a saved generation on A.
  using a = serverFixture(); using b = serverFixture(); using ownership = acquireRunLease(root);
  savedWork(a.url);
  const guard = await protectPrdStartup({ configDir: root, repoDir: root, options: parseArgs([]), interactive: false, ownership });
  // When another writer replaces the checkpoint while B validates; Then keep A.
  await expect(guard.acceptServer(b.url, async () => { writeFileSync(join(root, ".looper-run.json"), "changed"); })).rejects.toThrow("changed");
  expect(identity().serverUrl).toBe(a.url);
});

test("ownership loss while a server validates prevents authority mutation", async () => {
  // Given a protected startup whose lease record is replaced by another writer.
  using ownership = acquireRunLease(root);
  const guard = await protectPrdStartup({ configDir: root, repoDir: root, options: parseArgs([]), interactive: false, ownership });
  // When validation completes after ownership changed; Then no server is recorded.
  await expect(guard.acceptServer("http://replacement", async () => { writeFileSync(join(root, ".looper-run-owner.json"), "different owner"); })).rejects.toThrow("ownership changed");
  expect(identity().serverUrl).toBeUndefined();
});

test("TTY wiring uses one protected runtime snapshot and guards both deferred fresh actions", async () => {
  // Given the real TTY orchestration source.
  const source = await Bun.file(join(import.meta.dir, "../src/main.ts")).text();
  const tui = source.slice(source.indexOf("async function runTui("), source.indexOf("async function main("));
  // When inspecting its lifecycle boundaries; Then config cannot be reloaded after consent.
  expect(tui.match(/loadRuntimeConfig\(/g)).toHaveLength(1);
  expect(tui).toContain("Object.freeze(loadRuntimeConfig(configDir, repoDir))");
  expect(tui).toContain("const resetToFreshSlate = () => runFreshAction(");
  expect(tui).toContain("if (options.fresh) runFreshAction(beginProtectedRun)");
});
