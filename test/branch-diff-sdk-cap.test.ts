import { describe, expect, test } from "bun:test";

import {
  collectBranchDiff,
  MAX_BRANCH_DIFF_SDK_FILES,
  type BranchDiffVcsClient,
  type BranchDiffVcsFile,
} from "../src/watchers/branch-diff.ts";

const oneFile: BranchDiffVcsFile = { additions: 1, deletions: 0 };

function clientWithDiff(files: readonly BranchDiffVcsFile[]): BranchDiffVcsClient {
  return {
    vcs: {
      get: async () => ({ data: { branch: "feature", default_branch: "main" } }),
      diff: async () => ({ data: files }),
    },
  };
}

describe("branch diff SDK file cap", () => {
  test("aggregates an SDK diff exactly at the file limit", async () => {
    const result = await collectBranchDiff(clientWithDiff(Array.from({ length: MAX_BRANCH_DIFF_SDK_FILES }, () => oneFile)), "/repo", "feature");

    expect(result).toEqual({
      kind: "ok",
      totals: { additions: MAX_BRANCH_DIFF_SDK_FILES, deletions: 0, files: MAX_BRANCH_DIFF_SDK_FILES },
    });
  });

  test("rejects an SDK diff beyond the file limit with a typed error", async () => {
    let errorName = "";
    let errorMessage = "";
    try {
      await collectBranchDiff(clientWithDiff(Array.from({ length: MAX_BRANCH_DIFF_SDK_FILES + 1 }, () => oneFile)), "/repo", "feature");
    } catch (error) {
      if (error instanceof Error) {
        errorName = error.name;
        errorMessage = error.message;
      }
    }

    expect(errorName).toBe("BranchDiffSdkFileLimitError");
    expect(errorMessage).toMatch(/SDK diff exceeded 10000 files/);
  });
});
