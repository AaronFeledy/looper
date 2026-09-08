import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as phases from "../src/lib/story-state-files.ts";
import { createAdjudicationStore } from "../src/persistence/adjudication-store.ts";
import { initStatePaths, readRunState, writeFileAtomically } from "../src/lib/state-files.ts";
import { storyIdFromBranch } from "../src/lib/story-id.ts";
import { loadSteps, loadAdjudicateStep } from "../src/lib/config.ts";
import { nonNegativeIntegerEnv, positiveIntegerEnv, titleGenTimeoutMs } from "../src/config/tunables.ts";
import { createInMemoryAdjudicationStore } from "./helpers/adjudication-stub.ts";

let scratch: string;
beforeEach(() => {
  mkdirSync(join(import.meta.dir, ".tmp"), { recursive: true });
  scratch = mkdtempSync(join(import.meta.dir, ".tmp/persistence-audit-"));
  initStatePaths({ configDir: scratch });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

test("monotonic advancement observes a signal that supersedes an earlier read", () => {
  // Given an engine read followed by an explicit signal from another writer.
  phases.writeStoryPhase("US-1", "implemented");
  expect(phases.readStoryPhase("US-1")).toBe("implemented");
  phases.writeStoryPhase("US-1", "merged");
  // When the stale engine attempts its advancement.
  phases.advancePhaseMonotonic("US-1", "reviewed");
  // Then the signal's later phase survives.
  expect(phases.readStoryPhase("US-1")).toBe("merged");
});

test.each(["same reason", "new reason"])("completion preserves newer request %s", (reason) => {
  // Given A is consumed and bound, then B arrives (even with the same reason).
  const store = createAdjudicationStore({ configDir: scratch });
  store.writeMarker("same reason");
  const request = store.readRequest();
  if (request === null) throw new Error("missing fixture request");
  store.writeSession({ sessionID: "session-a", request });
  store.writeMarker(reason);
  const newer = store.readRequest();
  // When A completes.
  store.completeSession("session-a");
  // Then B remains and only A is logged as completed.
  expect(store.readRequest()).toEqual(newer);
  expect(newer?.id).not.toBe(request.id);
  expect(store.readCompletions()).toHaveLength(1);
  expect(store.readCompletions()[0]?.reason).toBe(request.reason);
  expect(store.readSession()).toBeNull();
});

test.each(["disk", "memory"])("%s completion requires a consumed request and matching session", (kind) => {
  // Given a request and a legacy session without request ownership.
  const store = kind === "disk" ? createAdjudicationStore({ configDir: scratch }) : createInMemoryAdjudicationStore();
  store.writeMarker("pending");
  store.writeSession({ sessionID: "legacy" });
  // When completion is attempted without a captured request, then fail closed.
  expect(() => store.completeSession("legacy")).toThrow();
  expect(store.readMarker()).toBe("pending");
  expect(store.readCompletions()).toEqual([]);
});

test("atomic writes sync file contents and renamed directory before returning", () => {
  // Given real fsync wrapped only to observe the durability contract.
  const original = fs.fsyncSync;
  const synced: string[] = [];
  const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    synced.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
    original(fd);
  });
  try {
    // When a durable signal is written.
    writeFileAtomically(join(scratch, "signal"), "stop");
    // Then both persistence barriers ran, in order.
    expect(synced).toEqual(["file", "directory"]);
  } finally {
    sync.mockRestore();
  }
});

test.each(["1e3", "15ms", "-0.5", "0.5", "9007199254740992"])("invalid integer env %s falls back", (value) => {
  // Given malformed integer overrides.
  const name = "LOOPER_TITLE_GEN_TIMEOUT_MS";
  const previous = process.env[name];
  process.env[name] = value;
  try {
    // When each integer path parses the complete value.
    const results = [positiveIntegerEnv(name, 123), nonNegativeIntegerEnv(name, 123), titleGenTimeoutMs()];
    // Then no truncated or disabling setting escapes.
    expect(results).toEqual([123, 123, 60_000]);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("empty story captures are absent", () => {
  // Given a regex with a zero-length capture; when deriving; then no story exists.
  expect(storyIdFromBranch("main", "^()")).toBeUndefined();
});
test("empty story IDs cannot be persisted", () => {
  // Given an empty external ID; when persisting; then reject it.
  expect(() => phases.writeStoryPhase("", "merged")).toThrow();
});

test.each(["", "   "])("blank step label %j is rejected before checkpointing", (name) => {
  // Given both regular and adjudication steps with an invalid display label.
  writeFileSync(join(scratch, "looper.yml"), `steps:\n  build:\n    name: ${JSON.stringify(name)}\n    prompt: a.md\nadjudicate:\n  name: ${JSON.stringify(name)}\n  prompt: a.md\n`);
  // When loading either step; then configuration fails at its boundary.
  expect(() => loadSteps(scratch)).toThrow(/name.*blank/);
  expect(() => loadAdjudicateStep(scratch)).toThrow(/name.*blank/);
});
test("invalid session-bearing pointer fails closed rather than looking absent", () => {
  // Given the formerly accepted blank-name checkpoint.
  writeFileSync(join(scratch, ".looper-run.json"), JSON.stringify({ iteration: 1, stepIndex: 0, stepName: "", sessionID: "active", updatedAt: "t" }));
  // When reading the run pointer; then fresh generation is not authorized.
  expect(() => readRunState()).toThrow(/checkpoint/);
});
