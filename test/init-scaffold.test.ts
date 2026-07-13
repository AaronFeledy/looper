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

  test("mentions the stop file path relative to the repo", () => {
    withScratchDir((repoDir) => {
      const configDir = join(repoDir, ".looper");
      scaffoldConfigDir({ configDir, repoDir });
      const checkDone = readFileSync(join(configDir, "check-done.md"), "utf8");
      expect(checkDone).toContain(".looper/.looper-stop");
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
