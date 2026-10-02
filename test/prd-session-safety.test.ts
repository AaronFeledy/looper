import { afterEach, beforeEach, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stopPrdSessions } from "../src/lib/prd-session-safety.ts";
import { acquireRunLease } from "../src/persistence/run-lease.ts";
import { protectPrdStartup } from "../src/lib/prd-startup.ts";
import { parseArgs } from "../src/lib/args.ts";

let root: string;
beforeEach(() => {
  const scratch = join(import.meta.dir, ".tmp"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "prd-safety-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function serverFixture(failChildren = false) {
  const aborted: string[] = [];
  const children: Record<string, readonly string[]> = { parent: ["child"], child: ["grandchild"], grandchild: [] };
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/session/status") return Response.json({});
    const id = path.split("/")[2] ?? "";
    if (path.endsWith("/abort")) { aborted.push(id); return Response.json(true); }
    if (path.endsWith("/children")) {
      if (failChildren) return Response.json({ error: "unknown children" }, { status: 503 });
      return Response.json((children[id] ?? []).map(child => ({ id: child })));
    }
    return Response.json({}, { status: 404 });
  } });
  return { url: server.url.toString(), client: createOpencodeClient({ baseUrl: server.url.toString() }), aborted, [Symbol.dispose]() { server.stop(true); } };
}

test("stops descendants even when the parent already appears idle", async () => {
  // Given an idle parent with nested delegated work.
  using fixture = serverFixture();
  // When reconciling the old generation.
  await stopPrdSessions({ client: fixture.client, repoDir: root, sessionIDs: ["parent"] });
  // Then every generation is explicitly stopped, not just the parent.
  expect(new Set(fixture.aborted)).toEqual(new Set(["parent", "child", "grandchild"]));
});

test("fails closed when child discovery fails", async () => {
  // Given an unavailable child API.
  using fixture = serverFixture(true);
  // When reconciling; Then uncertainty cannot authorize reset.
  await expect(stopPrdSessions({ client: fixture.client, repoDir: root, sessionIDs: ["parent"] })).rejects.toThrow();
});

test("fails closed when background continuation can reactivate a stopped session", async () => {
  // Given idle server status but an active continuation producer.
  using fixture = serverFixture();
  const dir = join(root, ".omo", "run-continuation"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "child.json"), JSON.stringify({ sessionID: "child", updatedAt: new Date().toISOString(), sources: { "background-task": { state: "active", updatedAt: new Date().toISOString() } } }));
  // When reconciling; Then the producer must finish before reset is safe.
  await expect(stopPrdSessions({ client: fixture.client, repoDir: root, sessionIDs: ["parent"] })).rejects.toThrow("continuation");
});

test("rejects a second run owner without removing the mutex", () => {
  // Given a live owner.
  using first = acquireRunLease(root);
  // When another frontend tries to start; Then it cannot launch overlapping work.
  expect(() => acquireRunLease(root)).toThrow("another Looper");
});

test("reconciles the recorded server instead of a newly configured server", async () => {
  // Given a server switch with an old in-flight generation.
  using original = serverFixture(); using replacement = serverFixture();
  writeFileSync(join(root, ".looper-prd-identity.json"), JSON.stringify({ version: 1, prdDir: null, serverUrl: original.url }));
  writeFileSync(join(root, ".looper-run.json"), JSON.stringify({ iteration: 1, stepIndex: 0, stepName: "Build", sessionID: "parent", updatedAt: "now" }));
  // When resetting with a new configured endpoint.
  using ownership = acquireRunLease(root);
  await protectPrdStartup({ configDir: root, repoDir: root, attachUrl: replacement.url, options: parseArgs(["--reset-prd-state", "--confirm-legacy-stopped"]), interactive: false, ownership });
  // Then only the original authority may confirm stop.
  expect(original.aborted).toContain("parent");
  expect(replacement.aborted).toEqual([]);
});
