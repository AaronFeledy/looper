import { describe, expect, test } from "bun:test";

import { computeCiRollup, parsePrListJson, parseRemoteIsGithub, type StatusCheckRollupEntry } from "../src/lib/github.ts";

describe("parseRemoteIsGithub", () => {
  test("matches scp-like ssh remotes", () => {
    expect(parseRemoteIsGithub("git@github.com:owner/repo.git")).toBe(true);
  });

  test("matches https remotes", () => {
    expect(parseRemoteIsGithub("https://github.com/owner/repo.git")).toBe(true);
  });

  test("matches ssh:// url remotes", () => {
    expect(parseRemoteIsGithub("ssh://git@github.com/owner/repo.git")).toBe(true);
  });

  test("is case-insensitive on the host", () => {
    expect(parseRemoteIsGithub("git@GitHub.com:owner/repo.git")).toBe(true);
  });

  test("rejects non-github hosts", () => {
    expect(parseRemoteIsGithub("git@gitlab.com:owner/repo.git")).toBe(false);
    expect(parseRemoteIsGithub("https://bitbucket.org/owner/repo.git")).toBe(false);
  });

  test("rejects github enterprise hosts", () => {
    expect(parseRemoteIsGithub("git@github.example.com:owner/repo.git")).toBe(false);
    expect(parseRemoteIsGithub("https://github.enterprise.io/owner/repo.git")).toBe(false);
  });

  test("rejects lookalike hosts that merely contain github.com", () => {
    expect(parseRemoteIsGithub("https://github.com.evil.example/owner/repo.git")).toBe(false);
    expect(parseRemoteIsGithub("git@notgithub.com:owner/repo.git")).toBe(false);
  });

  test("rejects empty / garbage input", () => {
    expect(parseRemoteIsGithub("")).toBe(false);
    expect(parseRemoteIsGithub("   ")).toBe(false);
    expect(parseRemoteIsGithub("not a url")).toBe(false);
  });
});

describe("computeCiRollup", () => {
  const checkRun = (status: string, conclusion = ""): StatusCheckRollupEntry => ({
    __typename: "CheckRun",
    status,
    conclusion,
  });
  const statusContext = (state: string): StatusCheckRollupEntry => ({ __typename: "StatusContext", state });

  test("empty rollup is 'none'", () => {
    expect(computeCiRollup([])).toEqual({ overall: "none", passing: 0, failing: 0, pending: 0, total: 0 });
  });

  test("an in-progress check run counts as pending", () => {
    const rollup = computeCiRollup([checkRun("IN_PROGRESS")]);
    expect(rollup).toEqual({ overall: "pending", passing: 0, failing: 0, pending: 1, total: 1 });
  });

  test("completed success counts as passing", () => {
    const rollup = computeCiRollup([checkRun("COMPLETED", "SUCCESS")]);
    expect(rollup).toEqual({ overall: "passing", passing: 1, failing: 0, pending: 0, total: 1 });
  });

  test("neutral and skipped conclusions count as passing", () => {
    const rollup = computeCiRollup([checkRun("COMPLETED", "NEUTRAL"), checkRun("COMPLETED", "SKIPPED")]);
    expect(rollup.overall).toBe("passing");
    expect(rollup.passing).toBe(2);
  });

  test("any failure dominates the overall verdict", () => {
    const rollup = computeCiRollup([
      checkRun("COMPLETED", "SUCCESS"),
      checkRun("IN_PROGRESS"),
      checkRun("COMPLETED", "FAILURE"),
    ]);
    expect(rollup).toEqual({ overall: "failing", passing: 1, failing: 1, pending: 1, total: 3 });
  });

  test("pending dominates over passing when there is no failure", () => {
    const rollup = computeCiRollup([checkRun("COMPLETED", "SUCCESS"), checkRun("QUEUED")]);
    expect(rollup.overall).toBe("pending");
  });

  test("legacy status contexts are classified by state", () => {
    expect(computeCiRollup([statusContext("SUCCESS")]).overall).toBe("passing");
    expect(computeCiRollup([statusContext("FAILURE")]).overall).toBe("failing");
    expect(computeCiRollup([statusContext("ERROR")]).overall).toBe("failing");
    expect(computeCiRollup([statusContext("PENDING")]).overall).toBe("pending");
  });

  test("treats unexpected timed-out / cancelled conclusions as failures", () => {
    expect(computeCiRollup([checkRun("COMPLETED", "TIMED_OUT")]).overall).toBe("failing");
    expect(computeCiRollup([checkRun("COMPLETED", "CANCELLED")]).overall).toBe("failing");
  });

  test("treats action-required / stale / startup-failure conclusions as failures", () => {
    expect(computeCiRollup([checkRun("COMPLETED", "ACTION_REQUIRED")]).overall).toBe("failing");
    expect(computeCiRollup([checkRun("COMPLETED", "STALE")]).overall).toBe("failing");
    expect(computeCiRollup([checkRun("COMPLETED", "STARTUP_FAILURE")]).overall).toBe("failing");
  });

  test("treats an expected status context as pending", () => {
    expect(computeCiRollup([statusContext("EXPECTED")]).overall).toBe("pending");
  });

  test("classifies a check run with empty conclusion (still running) as pending", () => {
    expect(computeCiRollup([checkRun("IN_PROGRESS", "")]).overall).toBe("pending");
  });
});

describe("parsePrListJson", () => {
  test("an empty array is the canonical no-pr signal", () => {
    expect(parsePrListJson("[]")).toEqual({ kind: "no-pr" });
  });

  test("ignores trailing whitespace around the array", () => {
    expect(parsePrListJson("  []\n")).toEqual({ kind: "no-pr" });
  });

  test("non-array payloads are treated as no-pr", () => {
    expect(parsePrListJson("{}")).toEqual({ kind: "no-pr" });
  });

  test("malformed JSON is reported as an error", () => {
    expect(parsePrListJson("not json")).toEqual({ kind: "error", message: "invalid gh output" });
  });

  test("an entry without a numeric number is treated as no-pr", () => {
    expect(parsePrListJson(JSON.stringify([{ title: "x" }]))).toEqual({ kind: "no-pr" });
  });

  test("maps the first PR with a computed CI rollup", () => {
    const payload = JSON.stringify([
      {
        number: 42,
        title: "Add widget",
        state: "open",
        isDraft: false,
        url: "https://github.com/owner/repo/pull/42",
        statusCheckRollup: [
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", status: "IN_PROGRESS" },
        ],
      },
    ]);
    expect(parsePrListJson(payload)).toEqual({
      kind: "pr",
      pr: {
        number: 42,
        title: "Add widget",
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/owner/repo/pull/42",
        ciOverall: "pending",
        ciPassing: 1,
        ciFailing: 0,
        ciPending: 1,
        ciTotal: 2,
      },
    });
  });

  test("uses only the first entry when gh returns multiple PRs", () => {
    const payload = JSON.stringify([
      { number: 7, title: "first", state: "OPEN", isDraft: true, url: "u7" },
      { number: 8, title: "second", state: "CLOSED", isDraft: false, url: "u8" },
    ]);
    const result = parsePrListJson(payload);
    expect(result).toEqual({
      kind: "pr",
      pr: {
        number: 7,
        title: "first",
        state: "OPEN",
        isDraft: true,
        url: "u7",
        ciOverall: "none",
        ciPassing: 0,
        ciFailing: 0,
        ciPending: 0,
        ciTotal: 0,
      },
    });
  });

  test("defaults missing optional fields", () => {
    const result = parsePrListJson(JSON.stringify([{ number: 1 }]));
    expect(result).toEqual({
      kind: "pr",
      pr: {
        number: 1,
        title: "",
        state: "",
        isDraft: false,
        url: "",
        ciOverall: "none",
        ciPassing: 0,
        ciFailing: 0,
        ciPending: 0,
        ciTotal: 0,
      },
    });
  });
});
