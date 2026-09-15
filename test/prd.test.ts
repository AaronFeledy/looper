import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countPrd,
  derivePrdPaths,
  prdIndexPath,
  PRD_INDEX_FILENAME,
  PRD_PROGRESS_FILENAME,
  readPrdStories,
  type PrdStory,
} from "../src/lib/prd.ts";

function withPrdDir(raw: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "looper-prd-"));
  try {
    writeFileSync(prdIndexPath(dir), raw);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readPrdStories", () => {
  test("parses id, title, priority, and dependsOn and ignores passes", () => {
    // Given a PRD with full story fields plus a leftover passes flag.
    const raw = JSON.stringify({
      userStories: [
        {
          id: "US-2",
          title: "Second",
          priority: 2,
          dependsOn: ["US-1"],
          passes: true,
        },
        {
          id: "US-1",
          title: "First",
          priority: 1,
          dependsOn: [],
          passes: false,
        },
      ],
    });

    // When stories are read.
    let stories: PrdStory[] | undefined;
    withPrdDir(raw, (dir) => {
      stories = readPrdStories(prdIndexPath(dir));
    });

    // Then identity fields are kept and passes is ignored.
    expect(stories).toEqual([
      { id: "US-2", title: "Second", priority: 2, dependsOn: ["US-1"] },
      { id: "US-1", title: "First", priority: 1, dependsOn: [] },
    ]);
  });

  test("skips entries without a usable id and omits optional title when absent", () => {
    const raw = JSON.stringify({
      userStories: [
        { passes: true },
        { id: "", title: "empty" },
        { id: "US-OK" },
        { id: "US-DEPS", dependsOn: ["US-OK", 1, "", null, "US-OTHER"] },
      ],
    });

    let stories: PrdStory[] | undefined;
    withPrdDir(raw, (dir) => {
      stories = readPrdStories(prdIndexPath(dir));
    });

    expect(stories).toEqual([
      { id: "US-OK", dependsOn: [] },
      { id: "US-DEPS", dependsOn: ["US-OK", "US-OTHER"] },
    ]);
  });

  test("returns undefined for missing file, invalid JSON, or missing userStories", () => {
    expect(readPrdStories(join(tmpdir(), "looper-prd-missing", "prd.json"))).toBeUndefined();

    withPrdDir("not json", (dir) => {
      expect(readPrdStories(prdIndexPath(dir))).toBeUndefined();
    });

    withPrdDir(JSON.stringify({ stories: [] }), (dir) => {
      expect(readPrdStories(prdIndexPath(dir))).toBeUndefined();
    });
  });
});

describe("countPrd", () => {
  test("counts remaining from effective phases vs terminal", () => {
    // Given three stories and mixed effective phases against terminal merged.
    const stories: PrdStory[] = [
      { id: "A", title: "a", dependsOn: [] },
      { id: "B", title: "b", dependsOn: [] },
      { id: "C", title: "c", dependsOn: [] },
    ];

    // When counting with A merged, B published, C missing (building).
    const result = countPrd({
      stories,
      phases: { A: "merged", B: "published" },
      terminal: "merged",
    });

    // Then only A is complete.
    expect(result).toEqual({ remaining: 2, total: 3 });
  });

  test("treats phase at or past terminal as complete", () => {
    const stories: PrdStory[] = [
      { id: "A", title: "a", dependsOn: [] },
      { id: "B", title: "b", dependsOn: [] },
    ];

    const result = countPrd({
      stories,
      phases: { A: "verified", B: "reviewed" },
      terminal: "verified",
    });

    expect(result).toEqual({ remaining: 1, total: 2 });
  });
});

describe("PRD path helpers", () => {
  test("uses the literal prd.json index filename", () => {
    expect(PRD_INDEX_FILENAME).toBe("prd.json");
    expect(prdIndexPath("/tmp/example")).toBe("/tmp/example/prd.json");
  });
});

describe("PRD path derivation", () => {
  test("uses repo-relative display paths when the PRD directory is inside the repository", () => {
    const repoDir = "/home/aaron/projects/looper";
    const prdDir = join(repoDir, "product", "prd");

    const paths = derivePrdPaths(prdDir, repoDir);

    expect(paths).toEqual({
      dir: join("product", "prd"),
      index: join("product", "prd", PRD_INDEX_FILENAME),
      progress: join("product", "prd", PRD_PROGRESS_FILENAME),
    });
    expect(PRD_PROGRESS_FILENAME).toBe("progress.txt");
  });

  test("uses absolute display paths when the PRD directory is outside the repository", () => {
    const prdDir = "/srv/shared/product-prd";

    const paths = derivePrdPaths(prdDir, "/home/aaron/projects/looper");

    expect(paths).toEqual({
      dir: prdDir,
      index: join(prdDir, PRD_INDEX_FILENAME),
      progress: join(prdDir, PRD_PROGRESS_FILENAME),
    });
  });
});
