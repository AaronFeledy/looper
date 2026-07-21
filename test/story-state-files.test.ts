import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearStoryState,
  comparePhase,
  isValidPhase,
  readStoryPhase,
  STORY_PHASE_ORDER,
  writeStoryPhase,
} from "../src/lib/story-state-files.ts";
import { initStatePaths } from "../src/lib/state-files.ts";

const TMP_ROOT = join(import.meta.dir, ".tmp");
const STORY_STATE_FILE = ".looper-story-state.json";

function writeMalformedPeerState(scratch: string): string {
  const statePath = join(scratch, STORY_STATE_FILE);
  writeFileSync(
    statePath,
    JSON.stringify({
      stories: {
        "US-074": { phase: "reviewed", updatedAt: "2026-07-20T10:00:00.000Z" },
        "US-BAD": { phase: "unknown", updatedAt: "2026-07-20T10:00:00.000Z" },
        "US-075": { phase: "implemented", updatedAt: "2026-07-20T10:00:00.000Z" },
      },
    }),
  );
  return statePath;
}

describe("story state files", () => {
  let scratch: string;

  beforeEach(() => {
    mkdirSync(TMP_ROOT, { recursive: true });
    scratch = mkdtempSync(join(TMP_ROOT, "story-state-"));
    initStatePaths({ configDir: scratch });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("recognizes exactly the supported story phases", () => {
    // Given every supported phase and representative invalid input.
    const invalid = ["", "Building", "done", "merged "];

    // When each value is checked.
    const validResults = STORY_PHASE_ORDER.map((phase) => isValidPhase(phase));
    const invalidResults = invalid.map((phase) => isValidPhase(phase));

    // Then only the supported literals are valid.
    expect(validResults).toEqual(STORY_PHASE_ORDER.map(() => true));
    expect(invalidResults).toEqual(invalid.map(() => false));
  });

  test("compares phases in lifecycle order", () => {
    // Given the exported lifecycle ordering.
    const adjacentPairs = [
      ["building", "implemented"],
      ["implemented", "reviewed"],
      ["reviewed", "verified"],
      ["verified", "published"],
      ["published", "merged"],
    ] as const;

    // When adjacent and identical phases are compared.
    const forward = adjacentPairs.map(([earlier, later]) => comparePhase(earlier, later));
    const backward = adjacentPairs.map(([earlier, later]) => comparePhase(later, earlier));
    const equal = STORY_PHASE_ORDER.map((phase) => comparePhase(phase, phase));

    // Then earlier phases sort before later phases and equal phases compare equal.
    expect(forward.every((result) => result < 0)).toBe(true);
    expect(backward.every((result) => result > 0)).toBe(true);
    expect(equal).toEqual(STORY_PHASE_ORDER.map(() => 0));
  });

  test("round-trips phases for multiple stories", () => {
    // Given two story lifecycle updates.
    writeStoryPhase("US-074", "reviewed");
    writeStoryPhase("US-075", "implemented");

    // When both stories are read back.
    const first = readStoryPhase("US-074");
    const second = readStoryPhase("US-075");

    // Then each story retains its independent phase.
    expect(first).toBe("reviewed");
    expect(second).toBe("implemented");
  });

  test("atomically overwrites one story without leaving temporary files", () => {
    // Given an existing story alongside another story.
    writeStoryPhase("US-074", "implemented");
    writeStoryPhase("US-075", "reviewed");

    // When the first story advances.
    writeStoryPhase("US-074", "verified");

    // Then the replacement is complete, the other story remains, and no temp file remains.
    expect(readStoryPhase("US-074")).toBe("verified");
    expect(readStoryPhase("US-075")).toBe("reviewed");
    expect(readdirSync(scratch).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("reads valid stories when a peer entry is malformed", () => {
    // Given two valid stories and one malformed peer entry.
    writeMalformedPeerState(scratch);

    // When the valid stories are read.
    const first = readStoryPhase("US-074");
    const second = readStoryPhase("US-075");

    // Then the malformed peer does not hide either valid story.
    expect(first).toBe("reviewed");
    expect(second).toBe("implemented");
  });

  test("preserves valid stories and drops a malformed peer on write", () => {
    // Given two valid stories and one malformed peer entry.
    const statePath = writeMalformedPeerState(scratch);

    // When a third valid story is written.
    writeStoryPhase("US-076", "published");

    // Then both valid peers and the new story remain while the malformed entry is omitted.
    const persisted: unknown = JSON.parse(readFileSync(statePath, "utf8"));
    expect(persisted).toMatchObject({
      stories: {
        "US-074": { phase: "reviewed", updatedAt: "2026-07-20T10:00:00.000Z" },
        "US-075": { phase: "implemented", updatedAt: "2026-07-20T10:00:00.000Z" },
        "US-076": { phase: "published", updatedAt: expect.any(String) },
      },
    });
    expect(persisted).not.toMatchObject({ stories: { "US-BAD": expect.anything() } });
  });

  test("treats malformed state as empty and repairs it on the next write", () => {
    // Given corrupt JSON at the story-state path.
    const statePath = join(scratch, STORY_STATE_FILE);
    writeFileSync(statePath, "not json");

    // When the corrupt state is read and a new phase is written.
    const beforeRepair = readStoryPhase("US-074");
    writeStoryPhase("US-075", "published");

    // Then the read is empty and the subsequent atomic write creates valid state.
    expect(beforeRepair).toBeUndefined();
    expect(readStoryPhase("US-074")).toBeUndefined();
    expect(readStoryPhase("US-075")).toBe("published");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      stories: { "US-075": { phase: "published", updatedAt: expect.any(String) } },
    });
  });

  test("clears story lifecycle state", () => {
    // Given persisted story state.
    writeStoryPhase("US-074", "merged");
    const statePath = join(scratch, STORY_STATE_FILE);
    expect(existsSync(statePath)).toBe(true);

    // When story state is cleared.
    clearStoryState();

    // Then the file is absent and reads return no phase.
    expect(existsSync(statePath)).toBe(false);
    expect(readStoryPhase("US-074")).toBeUndefined();
  });
});
