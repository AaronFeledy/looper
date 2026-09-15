import { describe, expect, test } from "bun:test";

import { filterMaterialPaths, materialPathsExist, prdDirRelative } from "../src/lib/material-paths.ts";

describe("filterMaterialPaths / materialPathsExist", () => {
  test("classifies paths against the PRD directory", () => {
    expect(materialPathsExist(["spec/progress.txt", "spec/prd.json"], "spec")).toBe(false);
    expect(materialPathsExist(["spec/progress.txt", "core/src/index.ts"], "spec")).toBe(true);
    expect(materialPathsExist([], "spec")).toBe(false);
    expect(materialPathsExist(["anything.txt"], undefined)).toBe(true);
    expect(materialPathsExist(["specification.md"], "spec")).toBe(true);
    expect(filterMaterialPaths(["spec/a", "src/b"], "spec")).toEqual(["src/b"]);
  });

  test("treats empty and parent-relative prdRel as no exclusion", () => {
    expect(filterMaterialPaths(["a"], "")).toEqual(["a"]);
    expect(filterMaterialPaths(["a"], "../outside")).toEqual(["a"]);
  });
});

describe("prdDirRelative", () => {
  test("returns undefined without a prd dir", () => {
    expect(prdDirRelative("/repo", undefined)).toBeUndefined();
  });

  test("returns a forward-slash relative path", () => {
    expect(prdDirRelative("/repo", "/repo/spec/beta")).toBe("spec/beta");
  });
});
