import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  clearStepAttempt,
  clearStepAttempts,
  readStepAttempt,
  readStoryStepAttempts,
  recordStepNonAdvance,
} from "../src/lib/step-attempt-files.ts";
import { initStatePaths } from "../src/lib/state-files.ts";

const dirs: string[] = [];
const LEDGER = ".looper-step-attempts.json";

function setup(): string {
  const configDir = join(import.meta.dir, ".tmp", `step-attempts-${crypto.randomUUID()}`);
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  dirs.push(configDir);
  return configDir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("step attempt ledger", () => {
  test("counts consecutive non-advancing attempts per story and step", () => {
    setup();
    expect(recordStepNonAdvance({ storyId: "US-1", stepName: "Build", kind: "handback", reason: "red" })).toBe(1);
    expect(recordStepNonAdvance({ storyId: "US-1", stepName: "Build", kind: "blocked", reason: "no CI" })).toBe(2);
    const record = readStepAttempt("US-1", "Build");
    expect(record?.count).toBe(2);
    expect(record?.lastKind).toBe("blocked");
    expect(record?.lastReason).toBe("no CI");
  });

  test("keeps stories and steps independent", () => {
    setup();
    recordStepNonAdvance({ storyId: "US-1", stepName: "Build", kind: "handback" });
    recordStepNonAdvance({ storyId: "US-1", stepName: "Review", kind: "handback" });
    recordStepNonAdvance({ storyId: "US-2", stepName: "Build", kind: "handback" });
    expect(readStepAttempt("US-1", "Build")?.count).toBe(1);
    expect(readStepAttempt("US-1", "Review")?.count).toBe(1);
    expect(readStepAttempt("US-2", "Build")?.count).toBe(1);
  });

  test("clearing one step leaves its siblings intact and prunes an emptied story", () => {
    setup();
    recordStepNonAdvance({ storyId: "US-1", stepName: "Build", kind: "handback" });
    recordStepNonAdvance({ storyId: "US-1", stepName: "Review", kind: "handback" });
    clearStepAttempt("US-1", "Build");
    expect(readStepAttempt("US-1", "Build")).toBeUndefined();
    expect(readStepAttempt("US-1", "Review")?.count).toBe(1);
    clearStepAttempt("US-1", "Review");
    expect(readStoryStepAttempts("US-1")).toEqual({});
  });

  test("a streak resumes from its stored count rather than restarting", () => {
    setup();
    recordStepNonAdvance({ storyId: "US-1", stepName: "Build", kind: "handback" });
    recordStepNonAdvance({ storyId: "US-1", stepName: "Build", kind: "handback" });
    clearStepAttempt("US-1", "Build");
    expect(recordStepNonAdvance({ storyId: "US-1", stepName: "Build", kind: "handback" })).toBe(1);
  });

  test("malformed entries are skipped while valid peers survive", () => {
    const configDir = setup();
    writeFileSync(
      join(configDir, LEDGER),
      JSON.stringify({
        attempts: {
          "US-1": { Build: { count: 2, lastAt: "2026-01-01T00:00:00.000Z", lastKind: "handback" }, Review: { count: -1, lastAt: "x", lastKind: "nope" } },
          "": { Build: { count: 1, lastAt: "2026-01-01T00:00:00.000Z", lastKind: "handback" } },
        },
      }),
    );
    expect(readStepAttempt("US-1", "Build")?.count).toBe(2);
    expect(readStepAttempt("US-1", "Review")).toBeUndefined();
  });

  test("unreadable or absent ledger reads as empty and never throws", () => {
    const configDir = setup();
    expect(readStepAttempt("US-1", "Build")).toBeUndefined();
    writeFileSync(join(configDir, LEDGER), "{ not json");
    expect(readStepAttempt("US-1", "Build")).toBeUndefined();
    expect(recordStepNonAdvance({ storyId: "US-1", stepName: "Build", kind: "handback" })).toBe(1);
  });

  test("empty story or step ids are rejected without writing", () => {
    setup();
    expect(recordStepNonAdvance({ storyId: "  ", stepName: "Build", kind: "handback" })).toBe(0);
    expect(recordStepNonAdvance({ storyId: "US-1", stepName: " ", kind: "handback" })).toBe(0);
    expect(readStoryStepAttempts("US-1")).toEqual({});
  });

  test("clear removes the whole ledger", () => {
    setup();
    recordStepNonAdvance({ storyId: "US-1", stepName: "Build", kind: "handback" });
    clearStepAttempts();
    expect(readStepAttempt("US-1", "Build")).toBeUndefined();
  });
});
