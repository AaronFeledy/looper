import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scaffoldConfigDir } from "../src/lib/init-scaffold.ts";
import { loadSteps } from "../src/lib/config.ts";

function withScratchDir(run: (repoDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "looper-init-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scaffoldConfigDir", () => {
  test("creates a loadable config with prompt files", () => {
    withScratchDir((repoDir) => {
      const configDir = join(repoDir, ".looper");
      const result = scaffoldConfigDir({ configDir, repoDir });
      expect(result.kind).toBe("created");
      expect(existsSync(join(configDir, "looper.yml"))).toBe(true);
      const steps = loadSteps(configDir);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(existsSync(step.prompt)).toBe(true);
      }
    });
  });

  test("does not scaffold the retired completion-check step", () => {
    withScratchDir((repoDir) => {
      const configDir = join(repoDir, ".looper");
      scaffoldConfigDir({ configDir, repoDir });
      const config = readFileSync(join(configDir, "looper.yml"), "utf8");
      expect(config).not.toContain("check-done");
      expect(existsSync(join(configDir, "check-done.md"))).toBe(false);
    });
  });

  test("scaffolds a commented prd example and a work prompt that signals story-phase", () => {
    withScratchDir((repoDir) => {
      const configDir = join(repoDir, ".looper");
      scaffoldConfigDir({ configDir, repoDir });
      const config = readFileSync(join(configDir, "looper.yml"), "utf8");
      expect(config).toContain("# prd: ");
      expect(config).toContain("# terminalPhase: merged");
      const steps = loadSteps(configDir);
      expect(steps.every((step) => step.gate === undefined && step.expects === undefined)).toBe(true);
      const work = readFileSync(join(configDir, "work.md"), "utf8");
      expect(work).toContain("looper signal story-phase implemented");
    });
  });

  test("ignores the machine-local lock file", () => {
    withScratchDir((repoDir) => {
      const configDir = join(repoDir, ".looper");
      const result = scaffoldConfigDir({ configDir, repoDir });
      expect(result.kind).toBe("created");
      const gitignore = readFileSync(join(configDir, ".gitignore"), "utf8");
      expect(gitignore).toContain(".looper-state-lock.sqlite");
      expect(gitignore).toContain(".looper-state-lock.sqlite-*");
    });
  });

  test("refuses to overwrite an existing config", () => {
    withScratchDir((repoDir) => {
      const configDir = join(repoDir, ".looper");
      scaffoldConfigDir({ configDir, repoDir });
      writeFileSync(join(configDir, "looper.yml"), "steps:\n  mine:\n    prompt: mine.md\n");
      const result = scaffoldConfigDir({ configDir, repoDir });
      expect(result.kind).toBe("already-initialized");
      expect(readFileSync(join(configDir, "looper.yml"), "utf8")).toContain("mine");
    });
  });
});
