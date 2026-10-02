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

describe("appendGateSkipToProgress repeat suppression", () => {
  function progressFile(initial = ""): string {
    const dir = mkdtempSync(join(tmpdir(), "looper-prd-progress-"));
    scratchDirs.push(dir);
    const progressPath = join(dir, "progress.txt");
    writeFileSync(progressPath, initial);
    return progressPath;
  }

  function skip(progressPath: string, stepName: string, reason: string, minute: number): void {
    const result = appendGateSkipToProgress({
      progressPath,
      stepName,
      reason,
      at: new Date(2026, 8, 6, 17, minute, 0),
    });
    expect(result).toEqual({ appended: true });
  }

  const BRANCH_REASON = "gate: branch is not a story branch (current 'main')";
  const PHASE_REASON = "gate: phase published is at or past implemented (nothing to do)";

  test("records a skip once while nothing else happens", () => {
    // Given a stalled loop re-running the same gated step every iteration.
    const progressPath = progressFile("## 2026-09-06 17:05 - US-608A\n- done\n---\n");

    // When the identical skip is appended three times.
    skip(progressPath, "Review", BRANCH_REASON, 10);
    skip(progressPath, "Review", BRANCH_REASON, 11);
    skip(progressPath, "Review", BRANCH_REASON, 12);

    // Then only the first is kept.
    const content = readFileSync(progressPath, "utf8");
    expect(content.split("- [looper] gate skipped Review").length - 1).toBe(1);
    expect(content).toContain("## 2026-09-06 17:10 - Review");
    expect(content).not.toContain("## 2026-09-06 17:11 - Review");
    // The real entry that preceded it is untouched.
    expect(content).toContain("## 2026-09-06 17:05 - US-608A");
  });

  test("keeps one entry per distinct step and per distinct reason", () => {
    // Given several steps gating off in the same iteration.
    const progressPath = progressFile("## 2026-09-06 17:05 - US-608A\n- done\n---\n");

    // When each reports, then the whole set repeats.
    skip(progressPath, "Review", BRANCH_REASON, 10);
    skip(progressPath, "Verify", BRANCH_REASON, 10);
    skip(progressPath, "Build", PHASE_REASON, 10);
    skip(progressPath, "Review", BRANCH_REASON, 11);
    skip(progressPath, "Verify", BRANCH_REASON, 11);
    skip(progressPath, "Build", PHASE_REASON, 11);

    // Then each distinct step is recorded exactly once.
    const content = readFileSync(progressPath, "utf8");
    expect(content.split("- [looper] gate skipped Review").length - 1).toBe(1);
    expect(content.split("- [looper] gate skipped Verify").length - 1).toBe(1);
    expect(content.split("- [looper] gate skipped Build").length - 1).toBe(1);

    // And the same step reporting a NEW reason is still recorded.
    skip(progressPath, "Review", PHASE_REASON, 12);
    expect(readFileSync(progressPath, "utf8").split("- [looper] gate skipped Review").length - 1).toBe(2);
  });

  test("a reason that is a prefix of a reported one is still recorded", () => {
    // `exited with code 1` is a prefix of `exited with code 10`; a substring
    // test would treat the shorter, genuinely new skip as already reported.
    const progressPath = progressFile("## 2026-09-06 17:05 - US-608A\n- done\n---\n");

    skip(progressPath, "Drift Audit", "gate: script exited with code 10", 10);
    skip(progressPath, "Drift Audit", "gate: script exited with code 1", 11);

    const content = readFileSync(progressPath, "utf8");
    expect(content).toContain("gate skipped Drift Audit: gate: script exited with code 10");
    expect(content).toContain("## 2026-09-06 17:11 - Drift Audit");
    expect(content.split("- [looper] gate skipped Drift Audit").length - 1).toBe(2);

    // And the exact repeat is still suppressed.
    skip(progressPath, "Drift Audit", "gate: script exited with code 1", 12);
    expect(readFileSync(progressPath, "utf8").split("- [looper] gate skipped Drift Audit").length - 1).toBe(2);
  });

  test("a real entry re-opens the window", () => {
    // Given a skip already reported.
    const progressPath = progressFile("## 2026-09-06 17:05 - US-608A\n- done\n---\n");
    skip(progressPath, "Review", BRANCH_REASON, 10);
    skip(progressPath, "Review", BRANCH_REASON, 11);
    expect(readFileSync(progressPath, "utf8").split("- [looper] gate skipped Review").length - 1).toBe(1);

    // When an agent records real work after it.
    writeFileSync(
      progressPath,
      `${readFileSync(progressPath, "utf8")}## 2026-09-06 17:30 - US-609\n- implemented\n---\n`,
    );

    // Then the next identical skip is recorded again, because the reader has
    // seen something happen since.
    skip(progressPath, "Review", BRANCH_REASON, 40);
    expect(readFileSync(progressPath, "utf8").split("- [looper] gate skipped Review").length - 1).toBe(2);
  });
});

describe("resolveProgressFilePath", () => {
  test("joins repo-relative progress paths", () => {
    expect(resolveProgressFilePath("spec/prd/progress.txt", "/repo")).toBe(join("/repo", "spec/prd/progress.txt"));
  });
});
