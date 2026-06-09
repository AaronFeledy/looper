import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSteps } from "../src/lib/config.ts";

function withConfigDir(contents: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "looper-config-"));
  try {
    writeFileSync(join(dir, "looper.yml"), contents);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadSteps config parsing", () => {
  test("rejects a top-level YAML array", () => {
    withConfigDir("- one\n- two\n", (dir) => {
      expect(() => loadSteps(dir)).toThrow(/must contain a mapping/);
    });
  });

  test("reports malformed YAML instead of leaking a raw parser error", () => {
    withConfigDir("steps: [unclosed\n", (dir) => {
      expect(() => loadSteps(dir)).toThrow(/is not valid YAML/);
    });
  });

  test("ignores a directory named like a config file and falls back", () => {
    const dir = mkdtempSync(join(tmpdir(), "looper-config-"));
    try {
      mkdirSync(join(dir, "looper.yml"));
      writeFileSync(join(dir, "looper.yaml"), "steps:\n  build:\n    prompt: hi\n");
      const steps = loadSteps(dir);
      expect(steps).toHaveLength(1);
      expect(steps[0]!.prompt).toContain("hi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
