import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import {
  appendGateSkipToProgress,
  formatGateSkipProgressEntry,
  formatProgressTimestamp,
  resolveProgressFilePath,
} from "../src/lib/prd-progress.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("formatGateSkipProgressEntry", () => {
  test("uses the progress-log heading shape with the skip line", () => {
    // Given a skip at a fixed instant.
    const at = new Date(2026, 8, 6, 17, 18, 0);

    // When the progress entry is formatted.
    const entry = formatGateSkipProgressEntry({
      stepName: "Review",
      reason: "gate: branch is not a story branch (current 'feat/foo'; expected a name matching ^([a-z]+-[0-9]+[a-z]?)-)",
      at,
    });

    // Then it matches the agent progress heading/body/rule format.
    expect(entry).toBe(
      `## ${formatProgressTimestamp(at)} - Review\n- [looper] gate skipped Review: gate: branch is not a story branch (current 'feat/foo'; expected a name matching ^([a-z]+-[0-9]+[a-z]?)-)\n---\n`,
    );
  });
});

describe("appendGateSkipToProgress", () => {
  test("appends after existing progress notes", () => {
    // Given an existing progress file.
    const dir = mkdtempSync(join(tmpdir(), "looper-prd-progress-"));
    scratchDirs.push(dir);
    const progressPath = join(dir, "progress.txt");
    writeFileSync(progressPath, "# Config translation progress\n\n## 2026-09-06 17:05 - US-608A\n- done\n---\n");
    const at = new Date(2026, 8, 6, 17, 21, 0);

    // When a gate skip is appended.
    const result = appendGateSkipToProgress({
      progressPath,
      stepName: "Review",
      reason: "gate: branch is not a story branch (current 'feat/foo'; expected a name matching ^([a-z]+-[0-9]+[a-z]?)-)",
      at,
    });

    // Then the original notes remain and the skip entry is last.
    expect(result).toEqual({ appended: true });
    expect(readFileSync(progressPath, "utf8")).toBe(
      `# Config translation progress\n\n## 2026-09-06 17:05 - US-608A\n- done\n---\n${formatGateSkipProgressEntry({
        stepName: "Review",
        reason: "gate: branch is not a story branch (current 'feat/foo'; expected a name matching ^([a-z]+-[0-9]+[a-z]?)-)",
        at,
      })}`,
    );
  });

  test("creates a missing progress file", () => {
    // Given no progress file yet.
    const dir = mkdtempSync(join(tmpdir(), "looper-prd-progress-"));
    scratchDirs.push(dir);
    const progressPath = join(dir, "nested", "progress.txt");
    const at = new Date(2026, 8, 6, 17, 21, 0);

    // When a gate skip is appended.
    const result = appendGateSkipToProgress({
      progressPath,
      stepName: "Verify",
      reason: "gate: branch is not main (current 'us-074-work'; expected 'main')",
      at,
    });

    // Then the file is created with only that entry.
    expect(result).toEqual({ appended: true });
    expect(readFileSync(progressPath, "utf8")).toBe(
      formatGateSkipProgressEntry({
        stepName: "Verify",
        reason: "gate: branch is not main (current 'us-074-work'; expected 'main')",
        at,
      }),
    );
  });
});

describe("resolveProgressFilePath", () => {
  test("joins repo-relative progress paths", () => {
    expect(resolveProgressFilePath("spec/prd/progress.txt", "/repo")).toBe(join("/repo", "spec/prd/progress.txt"));
  });
});
