import { describe, expect, test } from "bun:test";

import type { GithubStatus } from "../src/lib/state.ts";
import { buildGithubPrPanelLines, buildPrTitleLines } from "../src/tui/github-status.ts";
import { displayWidth } from "../src/tui/text-layout.ts";

const samplePr: Extract<GithubStatus, { kind: "pr" }> = {
  kind: "pr",
  pr: {
    number: 443,
    title: "My pull request",
    state: "OPEN",
    isDraft: false,
    url: "https://github.com/o/r/pull/443",
    ciOverall: "passing",
    ciPassing: 2,
    ciFailing: 0,
    ciPending: 0,
    ciNeutral: 0,
    ciTotal: 2,
    mergeable: "mergeable",
  },
};

describe("buildPrTitleLines", () => {
  test("prefixes first line with bracketed state", () => {
    expect(buildPrTitleLines(samplePr)).toEqual(["[open] My pull request"]);
  });

  test("uses draft label for open drafts", () => {
    const draft: Extract<GithubStatus, { kind: "pr" }> = {
      ...samplePr,
      pr: { ...samplePr.pr, isDraft: true },
    };
    expect(buildPrTitleLines(draft)[0]).toBe("[draft] My pull request");
  });

  test("wraps to two lines with ellipsis when title is long", () => {
    const long: Extract<GithubStatus, { kind: "pr" }> = {
      ...samplePr,
      pr: {
        ...samplePr.pr,
        title: "A very long pull request title that should not fit on a single sidebar line at all",
      },
    };
    const lines = buildPrTitleLines(long, 24, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]!.startsWith("[open] ")).toBe(true);
    expect(displayWidth(lines[lines.length - 1]!)).toBeLessThanOrEqual(24);
  });
});

describe("buildGithubPrPanelLines", () => {
  test("puts title before CI rows and omits old number row", () => {
    const lines = buildGithubPrPanelLines(samplePr, "⠋");
    expect(lines[0]!.content).toBe("[open] My pull request");
    expect(lines.some((line) => line.content.startsWith("#443"))).toBe(false);
    expect(lines.some((line) => line.content.includes("passing"))).toBe(true);
  });
});
