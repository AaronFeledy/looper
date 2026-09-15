import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { initStatePaths } from "../src/lib/state-files.ts";
import { readStoryPhase, writeStoryPhase } from "../src/lib/story-state-files.ts";

test("a cold writer cannot enter the read-modify-write transaction while another process owns it", () => {
  // Given a reserved OS lock held before a separate Bun writer starts.
  const root = join(import.meta.dir, ".tmp");
  mkdirSync(root, { recursive: true });
  const scratch = mkdtempSync(join(root, "persistence-lock-"));
  initStatePaths({ configDir: scratch });
  writeStoryPhase("US-1", "implemented");
  const db = new Database(join(scratch, ".looper-state-lock.sqlite"));
  const command = `import { initStatePaths } from './src/lib/state-files.ts'; import { writeStoryPhase } from './src/lib/story-state-files.ts'; initStatePaths({configDir:${JSON.stringify(scratch)}}); writeStoryPhase('US-2', 'merged');`;
  try {
    db.exec("BEGIN IMMEDIATE");
    // When the cold writer tries to update a different story under contention.
    const blocked = Bun.spawnSync([process.execPath, "-e", command], { cwd: join(import.meta.dir, ".."), timeout: 8_000 });
    db.exec("ROLLBACK");
    // Then it failed closed without losing the existing story; retry can commit.
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr.toString()).toMatch(/locked|busy/i);
    expect(readStoryPhase("US-2")).toBeUndefined();
    const retry = Bun.spawnSync([process.execPath, "-e", command], { cwd: join(import.meta.dir, "..") });
    expect(retry.exitCode).toBe(0);
    expect(readStoryPhase("US-1")).toBe("implemented");
    expect(readStoryPhase("US-2")).toBe("merged");
  } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 12_000);
