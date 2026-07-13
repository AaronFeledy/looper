import { describe, expect, test } from "bun:test";

import { TextAttributes } from "@opentui/core";
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

  test("returns no title lines when max lines is zero", () => {
    expect(buildPrTitleLines(samplePr, 24, 0)).toEqual([]);
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

  test("uses the full panel width for the continuation title line", () => {
    const long: Extract<GithubStatus, { kind: "pr" }> = {
      ...samplePr,
      pr: {
        ...samplePr.pr,
        title: "alpha beta gamma delta epsilon zeta eta theta",
      },
    };

    const lines = buildPrTitleLines(long, 24, 2);
    const continuation = lines[1];

    expect(lines).toHaveLength(2);
    expect(continuation).toBeDefined();
    if (continuation === undefined) throw new Error("expected a continuation title line");
    expect(displayWidth(continuation)).toBeGreaterThan(17);
    expect(displayWidth(continuation)).toBeLessThanOrEqual(24);
  });
});

describe("buildGithubPrPanelLines", () => {
  test("puts title before CI rows and omits old number row", () => {
    const lines = buildGithubPrPanelLines(samplePr, "⠋");
    expect(lines[0]!.content).toBe("[open] My pull request");
    expect(lines.some((line) => line.content.startsWith("#443"))).toBe(false);
    expect(lines.some((line) => line.content.includes("passing"))).toBe(true);
  });

  test("colors only the PR state segment in the title row", () => {
    const first = buildGithubPrPanelLines(samplePr, "⠋")[0]!;

    expect(first.fg).toBe("#a6adc8");
    expect(first.attrs).toBe(TextAttributes.NONE);
    expect(first.styledContent?.chunks.map((chunk) => chunk.text)).toEqual(["[open]", " ", "My pull request"]);
    expect(first.styledContent?.chunks[0]?.fg).toBeDefined();
    expect(first.styledContent?.chunks[2]?.fg).toBeUndefined();
    expect(first.styledContent?.chunks[0]?.attributes).toBe(TextAttributes.BOLD);
    expect(first.styledContent?.chunks[2]?.attributes).toBe(TextAttributes.BOLD);
  });

  test("bolds continuation title rows", () => {
    const long: Extract<GithubStatus, { kind: "pr" }> = {
      ...samplePr,
      pr: {
        ...samplePr.pr,
        title: "alpha beta gamma delta epsilon zeta eta theta",
      },
    };
    const second = buildGithubPrPanelLines(long, "⠋")[1];

    expect(second).toBeDefined();
    if (second === undefined) throw new Error("expected a continuation title row");
    expect(second.styledContent?.chunks).toHaveLength(1);
    expect(second.styledContent?.chunks[0]?.text).toBe(second.content);
    expect(second.styledContent?.chunks[0]?.attributes).toBe(TextAttributes.BOLD);
  });
});
