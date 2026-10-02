import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { preparePrdState } from "../src/lib/prd-state-protection.ts";
import { acquireRunLease } from "../src/persistence/run-lease.ts";
import { protectPrdStartup } from "../src/lib/prd-startup.ts";
import { parseArgs } from "../src/lib/args.ts";

let root: string;
beforeEach(() => {
  const scratch = join(import.meta.dir, ".tmp"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "prd-blockers-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function checkpoint(sessionID = "old") {
  writeFileSync(join(root, ".looper-run.json"), JSON.stringify({ iteration: 1, stepIndex: 0, stepName: "Build", sessionID, updatedAt: "now" }));
}

test.each([false, true])("no-PRD legacy checkpoint requires consent (fresh=%s)", async fresh => {
  // Given legacy work without a configured PRD.
  checkpoint(); let stopped = false;
  // When reopening without consent; Then it cannot silently authorize generation.
  await expect(preparePrdState({ configDir: root, repoDir: root, fresh, stopSessions: async () => { stopped = true; } })).rejects.toThrow("--adopt-prd-state");
  expect(stopped).toBe(false);
  expect(existsSync(join(root, ".looper-run.json"))).toBe(true);
});

test("clean no-PRD startup needs no migration flags", async () => {
  // Given a new state directory; When starting without a PRD.
  await preparePrdState({ configDir: root, repoDir: root, fresh: false, stopSessions: async () => { throw new Error("unexpected stop"); } });
  // Then it records the protected writer protocol, avoiding future legacy ambiguity.
  expect(JSON.parse(readFileSync(join(root, ".looper-prd-identity.json"), "utf8"))).toMatchObject({ prdDir: null, writerProtocol: 1 });
});

test.each(["adopt", "reset"] as const)("%s does not acknowledge shutdown of unknown legacy frontends", async decision => {
  // Given a pre-lease writer whose parent could appear idle between generations.
  checkpoint(); let stopCalls = 0;
  // When only adoption/reset is authorized; Then require separate frontend shutdown evidence.
  await expect(preparePrdState({ configDir: root, repoDir: root, fresh: false, decision, stopSessions: async () => { stopCalls++; } })).rejects.toThrow("--confirm-legacy-stopped");
  expect(stopCalls).toBe(0);
  expect(existsSync(join(root, ".looper-archive"))).toBe(false);
});

test("an existing identity without writer provenance still needs shutdown acknowledgment", async () => {
  // Given state written by the first, unfenced implementation.
  writeFileSync(join(root, ".looper-prd-identity.json"), '{"version":1,"prdDir":null}'); checkpoint();
  // When resuming the same association; Then an old idle parent is insufficient.
  await expect(preparePrdState({ configDir: root, repoDir: root, fresh: false, stopSessions: async () => {} })).rejects.toThrow("--confirm-legacy-stopped");
});

test("a known live frontend owner cannot be overwritten by acquiring a new SQLite lease", () => {
  // Given process evidence from a writer that does not hold the new mutex.
  const owner = JSON.stringify({ version: 1, pid: process.pid, host: hostname(), token: "pre-upgrade" });
  writeFileSync(join(root, ".looper-run-owner.json"), owner);
  // When acquiring ownership; Then do not steal the writer's state directory.
  expect(() => { using lease = acquireRunLease(root); }).toThrow("frontend");
  expect(readFileSync(join(root, ".looper-run-owner.json"), "utf8")).toBe(owner);
});

test("failed server validation cannot replace authority for saved work", async () => {
  // Given A owns a saved generation and B has not been validated/reconciled.
  checkpoint();
  const identity = JSON.stringify({ version: 1, prdDir: null, serverUrl: "http://server-a", writerProtocol: 1 });
  writeFileSync(join(root, ".looper-prd-identity.json"), identity);
  using ownership = acquireRunLease(root);
  const guard = await protectPrdStartup({ configDir: root, repoDir: root, options: parseArgs([]), interactive: false, ownership });
  // When replacement validation fails; Then retain the original authority.
  await expect(guard.acceptServer("http://server-b", async () => { throw new Error("validation failed"); })).rejects.toThrow("validation failed");
  expect(JSON.parse(readFileSync(join(root, ".looper-prd-identity.json"), "utf8"))).toEqual(JSON.parse(identity));
});
