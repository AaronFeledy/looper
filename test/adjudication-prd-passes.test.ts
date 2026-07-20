import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readPrdPasses } from "../src/engine/adjudication-routing.ts";

const scratchDirs: string[] = [];

function withPrd(contents: string | null, run: (prdDir: string) => void): void {
  const prdDir = mkdtempSync(join(tmpdir(), "looper-prd-passes-"));
  scratchDirs.push(prdDir);
  if (contents !== null) writeFileSync(join(prdDir, "prd.json"), contents);
  run(prdDir);
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readPrdPasses canonical alignment", () => {
  test("maps each story to a strict passes === true reading", () => {
    withPrd(JSON.stringify({ userStories: [{ id: "a", passes: true }, { id: "b", passes: false }] }), (prdDir) => {
      expect(readPrdPasses(prdDir)).toEqual({ a: true, b: false });
    });
  });

  test("treats a missing or non-boolean passes as not passing rather than discarding the snapshot", () => {
    withPrd(JSON.stringify({ userStories: [{ id: "a" }, { id: "b", passes: "yes" }, { id: "c", passes: true }] }), (prdDir) => {
      expect(readPrdPasses(prdDir)).toEqual({ a: false, b: false, c: true });
    });
  });

  test("skips only the stories without a usable id and keeps the rest", () => {
    withPrd(JSON.stringify({ userStories: [{ passes: true }, { id: "", passes: true }, { id: "keep", passes: true }] }), (prdDir) => {
      expect(readPrdPasses(prdDir)).toEqual({ keep: true });
    });
  });

  test("returns undefined for an absent prd.json", () => {
    withPrd(null, (prdDir) => {
      expect(readPrdPasses(prdDir)).toBeUndefined();
    });
  });

  test("returns undefined for malformed JSON", () => {
    withPrd("not json", (prdDir) => {
      expect(readPrdPasses(prdDir)).toBeUndefined();
    });
  });

  test("returns undefined when userStories is not an array", () => {
    withPrd(JSON.stringify({ userStories: {} }), (prdDir) => {
      expect(readPrdPasses(prdDir)).toBeUndefined();
    });
  });
});
