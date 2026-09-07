import { describe, expect, test } from "bun:test";

import { DEFAULT_STORY_ID_PATTERN } from "../src/lib/story-id.ts";
import {
  decideStoryBranchMismatch,
  storyBranchMismatchLogLine,
  storyBranchMismatchPrompt,
} from "../src/engine/story-branch-nudge.ts";

const PATTERN = DEFAULT_STORY_ID_PATTERN;

describe("decideStoryBranchMismatch", () => {
  test("returns none when the branch did not switch", () => {
    expect(
      decideStoryBranchMismatch({
        initialBranch: "feat/foo",
        currentBranch: "feat/foo",
        pattern: PATTERN,
      }),
    ).toBeUndefined();
  });

  test("returns none when the switch is onto a trivial default branch", () => {
    expect(
      decideStoryBranchMismatch({
        initialBranch: "feat/foo",
        currentBranch: "main",
        pattern: PATTERN,
      }),
    ).toBeUndefined();
  });

  test("returns none when the switch is onto a story branch", () => {
    expect(
      decideStoryBranchMismatch({
        initialBranch: "main",
        currentBranch: "us-608a-authoring-translation-contracts",
        pattern: PATTERN,
      }),
    ).toBeUndefined();
  });

  test("returns a mismatch when the switch is onto a non-story feature branch", () => {
    expect(
      decideStoryBranchMismatch({
        initialBranch: "main",
        currentBranch: "feat/authoring-translation-contracts",
        pattern: PATTERN,
      }),
    ).toEqual({
      branch: "feat/authoring-translation-contracts",
      pattern: PATTERN,
    });
  });
});

describe("storyBranchMismatchPrompt", () => {
  test("carries the switched branch and the story-id pattern", () => {
    const mismatch = {
      branch: "feat/authoring-translation-contracts",
      pattern: PATTERN,
    };

    const prompt = storyBranchMismatchPrompt(mismatch);

    expect(prompt).toContain(`'${mismatch.branch}'`);
    expect(prompt).toContain(mismatch.pattern);
    expect(prompt.startsWith("Continue working")).toBe(true);
  });
});

describe("storyBranchMismatchLogLine", () => {
  test("names the branch and pattern", () => {
    expect(
      storyBranchMismatchLogLine({
        branch: "feat/foo",
        pattern: PATTERN,
      }),
    ).toBe(`[looper] branch 'feat/foo' does not match story id pattern ${PATTERN}`);
  });
});
