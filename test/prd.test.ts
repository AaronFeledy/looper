import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countPrd, derivePrdPaths, prdIndexPath, PRD_INDEX_FILENAME, PRD_PROGRESS_FILENAME, readPrd } from "../src/lib/prd.ts";

function withPrdDir(raw: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "looper-prd-"));
  try {
    writeFileSync(prdIndexPath(dir), raw);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("prd.json parsing", () => {
  test("counts stories as remaining when passes is not true", () => {
    const raw = JSON.stringify({ userStories: [{ passes: true }, { passes: false }, { passes: null }, {}] });

    const result = countPrd(raw);

    expect(result).toEqual({ kind: "ok", remaining: 3, total: 4 });
  });

  test("counts non-object stories as remaining", () => {
    const raw = JSON.stringify({ userStories: [{ passes: true }, null, "story"] });

    const result = countPrd(raw);

    expect(result).toEqual({ kind: "ok", remaining: 2, total: 3 });
  });

  test("returns an error for malformed JSON", () => {
    const result = countPrd("not json");

    if (result.kind !== "error") throw new Error("expected malformed JSON to return an error");
    expect(result.message).toContain("invalid JSON");
  });

  test("returns an error when userStories is missing", () => {
    const result = countPrd(JSON.stringify({ stories: [] }));

    expect(result).toEqual({ kind: "error", message: "missing userStories" });
  });
});

describe("prd.json reading", () => {
  test("uses the literal prd.json index filename", () => {
    expect(PRD_INDEX_FILENAME).toBe("prd.json");
    expect(prdIndexPath("/tmp/example")).toBe("/tmp/example/prd.json");
  });

  test("returns an error for a nonexistent directory or file", () => {
    const result = readPrd(join(tmpdir(), "looper-prd-does-not-exist"));

    if (result.kind !== "error") throw new Error("expected missing prd.json to return an error");
    expect(result.message).toBe("prd.json not found");
  });

  test("maps invalid file content to an error result", () => {
    withPrdDir("not json", (dir) => {
      const result = readPrd(dir);

      if (result.kind !== "error") throw new Error("expected invalid prd.json to return an error");
      expect(result.message).toContain("invalid JSON");
    });
  });

  test("counts a deterministic prd.json fixture", () => {
    const raw = JSON.stringify({ userStories: [{ passes: true }, { passes: false }, { passes: null }, {}] });

    withPrdDir(raw, (dir) => {
      const result = readPrd(dir);

      expect(result).toEqual({ kind: "ok", remaining: 3, total: 4 });
    });
  });
});

describe("PRD path derivation", () => {
  test("uses repo-relative display paths when the PRD directory is inside the repository", () => {
    // Given an absolute PRD directory nested inside the repository.
    const repoDir = "/home/aaron/projects/looper";
    const prdDir = join(repoDir, "product", "prd");

    // When display paths are derived.
    const paths = derivePrdPaths(prdDir, repoDir);

    // Then every path is repository-relative and includes the conventional filenames.
    expect(paths).toEqual({
      dir: join("product", "prd"),
      index: join("product", "prd", PRD_INDEX_FILENAME),
      progress: join("product", "prd", PRD_PROGRESS_FILENAME),
    });
    expect(PRD_PROGRESS_FILENAME).toBe("progress.txt");
  });

  test("uses absolute display paths when the PRD directory is outside the repository", () => {
    // Given an absolute PRD directory outside the repository.
    const prdDir = "/srv/shared/product-prd";

    // When display paths are derived.
    const paths = derivePrdPaths(prdDir, "/home/aaron/projects/looper");

    // Then every path remains absolute.
    expect(paths).toEqual({
      dir: prdDir,
      index: join(prdDir, PRD_INDEX_FILENAME),
      progress: join(prdDir, PRD_PROGRESS_FILENAME),
    });
  });
});
