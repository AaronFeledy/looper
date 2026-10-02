import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initStatePaths } from "../src/lib/state-files.ts";
import { advancePhaseMonotonic, readStoryPhase, writeStoryPhase } from "../src/lib/story-state-files.ts";
import { clearStepAttempt, readStepAttempt, readStoryStepAttempts, recordStepNonAdvance } from "../src/lib/step-attempt-files.ts";
import { createStoryPhaseResolver, isPrdComplete, selectNextStory } from "../src/engine/story-phases.ts";

let root: string;
beforeEach(() => {
  const scratch = join(import.meta.dir, ".tmp");
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "state-keys-"));
  initStatePaths({ configDir: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("prototype-shaped story IDs survive peer updates and monotonic advances", () => {
  writeStoryPhase("__proto__", "reviewed");
  writeStoryPhase("US-1", "implemented");
  expect(readStoryPhase("__proto__")).toBe("reviewed");
  advancePhaseMonotonic("__proto__", "building");
  expect(readStoryPhase("__proto__")).toBe("reviewed");
  expect(Object.hasOwn(JSON.parse(readFileSync(join(root, ".looper-story-state.json"), "utf8")).stories, "__proto__")).toBe(true);
});

test.each(["__proto__", "constructor", "toString"])("absent attempt keys %s do not inherit object members", key => {
  expect(readStepAttempt("US-1", key)).toBeUndefined();
  expect(readStoryStepAttempts(key)).toEqual({});
  recordStepNonAdvance({ storyId: "US-1", stepName: "Build", kind: "blocked" });
  expect(readStepAttempt("US-1", key)).toBeUndefined();
});

test.each([["__proto__", "Build"], ["US-1", "__proto__"], ["constructor", "toString"]])(
  "attempt count for (%s, %s) survives another step write and clear", (storyId, stepName) => {
    expect(recordStepNonAdvance({ storyId: storyId!, stepName: stepName!, kind: "blocked" })).toBe(1);
    recordStepNonAdvance({ storyId: "peer", stepName: "Review", kind: "handback" });
    expect(recordStepNonAdvance({ storyId: storyId!, stepName: stepName!, kind: "blocked" })).toBe(2);
    expect(readStepAttempt(storyId!, stepName!)?.count).toBe(2);
    clearStepAttempt(storyId!, stepName!);
    expect(readStepAttempt(storyId!, stepName!)).toBeUndefined();
    expect(readStepAttempt("peer", "Review")?.count).toBe(1);
  },
);

test("resolver records a terminal phase even for __proto__", () => {
  const resolver = createStoryPhaseResolver({ repoDir: root, prdIndex: "unused", storyFetchTimeoutMs: 0,
    readStories: () => [{ id: "__proto__", dependsOn: [] }], storyState: { readPhase: () => "merged" } });
  const snapshot = resolver.snapshot()!;
  expect(snapshot.phases["__proto__"]).toBe("merged");
  expect(isPrdComplete(snapshot)).toBe(true);
  expect(selectNextStory(snapshot, undefined)).toBeUndefined();
});
