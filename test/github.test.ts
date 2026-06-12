import { describe, expect, test } from "bun:test";

import {
  classifyBugbot,
  classifyMergeable,
  computeCiRollup,
  countUnresolvedBugbotThreads,
  isBugbotEntry,
  isBugbotLogin,
  parseBugbotThreadsPage,
  parsePrListJson,
  parsePrUrl,
  parseRemoteIsGithub,
  partitionBugbot,
  type StatusCheckRollupEntry,
} from "../src/lib/github.ts";

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
    expect(computeCiRollup([])).toEqual({ overall: "none", passing: 0, failing: 0, pending: 0, neutral: 0, total: 0 });
  });

  test("an in-progress check run counts as pending", () => {
    const rollup = computeCiRollup([checkRun("IN_PROGRESS")]);
    expect(rollup).toEqual({ overall: "pending", passing: 0, failing: 0, pending: 1, neutral: 0, total: 1 });
  });

  test("completed success counts as passing", () => {
    const rollup = computeCiRollup([checkRun("COMPLETED", "SUCCESS")]);
    expect(rollup).toEqual({ overall: "passing", passing: 1, failing: 0, pending: 0, neutral: 0, total: 1 });
  });

  test("skipped counts as passing; neutral is tracked apart from passing", () => {
    const rollup = computeCiRollup([checkRun("COMPLETED", "NEUTRAL"), checkRun("COMPLETED", "SKIPPED")]);
    expect(rollup).toEqual({ overall: "passing", passing: 1, failing: 0, pending: 0, neutral: 1, total: 2 });
  });

  test("a lone neutral check makes the overall verdict 'neutral'", () => {
    const rollup = computeCiRollup([checkRun("COMPLETED", "NEUTRAL")]);
    expect(rollup).toEqual({ overall: "neutral", passing: 0, failing: 0, pending: 0, neutral: 1, total: 1 });
  });

  test("any failure dominates the overall verdict", () => {
    const rollup = computeCiRollup([
      checkRun("COMPLETED", "SUCCESS"),
      checkRun("IN_PROGRESS"),
      checkRun("COMPLETED", "FAILURE"),
    ]);
    expect(rollup).toEqual({ overall: "failing", passing: 1, failing: 1, pending: 1, neutral: 0, total: 3 });
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
        ciNeutral: 0,
        ciTotal: 2,
        mergeable: "unknown",
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
        ciNeutral: 0,
        ciTotal: 0,
        mergeable: "unknown",
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
        ciNeutral: 0,
        ciTotal: 0,
        mergeable: "unknown",
      },
    });
  });
});


describe("bugbot detection", () => {
  const bugbotCheck = (conclusion = "SUCCESS"): StatusCheckRollupEntry => ({
    __typename: "CheckRun",
    name: "Cursor Bugbot",
    detailsUrl: "https://cursor.com/docs/bugbot",
    status: "COMPLETED",
    conclusion,
  });

  test("isBugbotEntry matches by name", () => {
    expect(isBugbotEntry({ name: "Cursor Bugbot" })).toBe(true);
    expect(isBugbotEntry({ name: "bugbot" })).toBe(true);
  });

  test("isBugbotEntry matches by detailsUrl when name is unhelpful", () => {
    expect(isBugbotEntry({ name: "review", detailsUrl: "https://cursor.com/docs/bugbot" })).toBe(true);
  });

  test("isBugbotEntry rejects ordinary CI checks", () => {
    expect(isBugbotEntry({ name: "static-checks", detailsUrl: "https://github.com/o/r/actions" })).toBe(false);
  });

  test("classifyBugbot maps conclusions to states", () => {
    expect(classifyBugbot(bugbotCheck("SUCCESS"))).toBe("clean");
    expect(classifyBugbot(bugbotCheck("SKIPPED"))).toBe("clean");
    expect(classifyBugbot(bugbotCheck("NEUTRAL"))).toBe("issues");
    expect(classifyBugbot(bugbotCheck("FAILURE"))).toBe("error");
  });

  test("classifyBugbot treats an in-progress run as pending", () => {
    expect(classifyBugbot({ __typename: "CheckRun", name: "Cursor Bugbot", status: "IN_PROGRESS" })).toBe("pending");
    expect(classifyBugbot({ __typename: "CheckRun", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "" })).toBe("pending");
  });

  test("partitionBugbot removes the bugbot entry from the CI set", () => {
    const entries: StatusCheckRollupEntry[] = [
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      bugbotCheck("NEUTRAL"),
    ];
    const { bugbot, ci } = partitionBugbot(entries);
    expect(bugbot?.name).toBe("Cursor Bugbot");
    expect(ci).toHaveLength(1);
    expect(ci[0]?.name).toBe("ci");
  });

  test("isBugbotEntry falls back to context when name is an empty string", () => {
    expect(isBugbotEntry({ name: "", context: "Cursor Bugbot" })).toBe(true);
  });

  test("partitionBugbot keeps the most recent bugbot run by completedAt", () => {
    const older: StatusCheckRollupEntry = {
      __typename: "CheckRun",
      name: "Cursor Bugbot",
      status: "COMPLETED",
      conclusion: "NEUTRAL",
      completedAt: "2026-01-01T00:00:00Z",
    };
    const newer: StatusCheckRollupEntry = {
      __typename: "CheckRun",
      name: "Cursor Bugbot",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      completedAt: "2026-01-02T00:00:00Z",
    };
    // Newer run appears first in the array, so plain "last wins" would pick the
    // stale NEUTRAL entry; the timestamp comparison must keep the SUCCESS run.
    const { bugbot } = partitionBugbot([newer, older]);
    expect(bugbot?.conclusion).toBe("SUCCESS");
  });

  test("partitionBugbot falls back to last seen when timestamps are absent", () => {
    const first = bugbotCheck("SUCCESS");
    const second = bugbotCheck("NEUTRAL");
    const { bugbot } = partitionBugbot([first, second]);
    expect(bugbot?.conclusion).toBe("NEUTRAL");
  });
});

describe("parsePrListJson with bugbot", () => {
  test("surfaces a NEUTRAL bugbot as 'issues' and keeps it out of the CI rollup", () => {
    const payload = JSON.stringify([
      {
        number: 316,
        title: "Add thing",
        state: "open",
        isDraft: false,
        url: "https://github.com/AaronFeledy/core4/pull/316",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "Cursor Bugbot", detailsUrl: "https://cursor.com/docs/bugbot", status: "COMPLETED", conclusion: "NEUTRAL" },
        ],
      },
    ]);
    const result = parsePrListJson(payload);
    expect(result).toEqual({
      kind: "pr",
      pr: {
        number: 316,
        title: "Add thing",
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/AaronFeledy/core4/pull/316",
        ciOverall: "passing",
        ciPassing: 1,
        ciFailing: 0,
        ciPending: 0,
        ciNeutral: 0,
        ciTotal: 1,
        mergeable: "unknown",
        bugbot: { state: "issues" },
      },
    });
  });

  test("a clean bugbot run is reported as 'clean'", () => {
    const payload = JSON.stringify([
      {
        number: 1,
        url: "https://github.com/o/r/pull/1",
        statusCheckRollup: [{ __typename: "CheckRun", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" }],
      },
    ]);
    const result = parsePrListJson(payload);
    if (result.kind !== "pr") throw new Error("expected pr");
    expect(result.pr.bugbot).toEqual({ state: "clean" });
    expect(result.pr.ciTotal).toBe(0);
  });

  test("omits the bugbot field entirely when no bugbot check exists", () => {
    const result = parsePrListJson(JSON.stringify([{ number: 1 }]));
    if (result.kind !== "pr") throw new Error("expected pr");
    expect(result.pr.bugbot).toBeUndefined();
  });
});

describe("classifyMergeable", () => {
  test("maps GitHub's mergeable states", () => {
    expect(classifyMergeable("MERGEABLE")).toBe("mergeable");
    expect(classifyMergeable("CONFLICTING")).toBe("conflicting");
    expect(classifyMergeable("UNKNOWN")).toBe("unknown");
  });

  test("is case-insensitive", () => {
    expect(classifyMergeable("conflicting")).toBe("conflicting");
  });

  test("treats a missing / unrecognized value as unknown", () => {
    expect(classifyMergeable(undefined)).toBe("unknown");
    expect(classifyMergeable("")).toBe("unknown");
    expect(classifyMergeable("DIRTY")).toBe("unknown");
  });
});

describe("parsePrListJson mergeable", () => {
  test("surfaces a conflicting PR", () => {
    const payload = JSON.stringify([
      { number: 339, url: "https://github.com/AaronFeledy/core4/pull/339", mergeable: "CONFLICTING" },
    ]);
    const result = parsePrListJson(payload);
    if (result.kind !== "pr") throw new Error("expected pr");
    expect(result.pr.mergeable).toBe("conflicting");
  });

  test("a clean PR is mergeable", () => {
    const result = parsePrListJson(JSON.stringify([{ number: 1, mergeable: "MERGEABLE" }]));
    if (result.kind !== "pr") throw new Error("expected pr");
    expect(result.pr.mergeable).toBe("mergeable");
  });

  test("a PR without a mergeable field defaults to unknown", () => {
    const result = parsePrListJson(JSON.stringify([{ number: 1 }]));
    if (result.kind !== "pr") throw new Error("expected pr");
    expect(result.pr.mergeable).toBe("unknown");
  });
});

describe("parsePrUrl", () => {
  test("extracts owner/repo/number from a PR url", () => {
    expect(parsePrUrl("https://github.com/AaronFeledy/core4/pull/316")).toEqual({
      owner: "AaronFeledy",
      repo: "core4",
      number: 316,
    });
  });

  test("returns null for non-PR urls", () => {
    expect(parsePrUrl("https://github.com/o/r")).toBeNull();
    expect(parsePrUrl("")).toBeNull();
  });
});

describe("isBugbotLogin", () => {
  test("matches the cursor bot logins", () => {
    expect(isBugbotLogin("cursor")).toBe(true);
    expect(isBugbotLogin("cursor[bot]")).toBe(true);
    expect(isBugbotLogin("Cursor")).toBe(true);
  });

  test("rejects human logins", () => {
    expect(isBugbotLogin("AaronFeledy")).toBe(false);
    expect(isBugbotLogin("cursor-fan")).toBe(false);
  });
});

describe("countUnresolvedBugbotThreads", () => {
  const thread = (isResolved: boolean, login: string) => ({
    isResolved,
    comments: { nodes: [{ author: { login } }] },
  });

  const payload = (threads: unknown[]) =>
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } });

  test("counts only unresolved threads authored by bugbot", () => {
    const stdout = payload([
      thread(false, "cursor"),
      thread(true, "cursor"),
      thread(false, "AaronFeledy"),
      thread(false, "cursor[bot]"),
    ]);
    expect(countUnresolvedBugbotThreads(stdout)).toBe(2);
  });

  test("returns 0 when every bugbot thread is resolved", () => {
    expect(countUnresolvedBugbotThreads(payload([thread(true, "cursor"), thread(true, "cursor")]))).toBe(0);
  });

  test("returns null on malformed input", () => {
    expect(countUnresolvedBugbotThreads("not json")).toBeNull();
    expect(countUnresolvedBugbotThreads("{}")).toBeNull();
  });
});

describe("parseBugbotThreadsPage", () => {
  const thread = (isResolved: boolean, login: string) => ({
    isResolved,
    comments: { nodes: [{ author: { login } }] },
  });

  const payload = (threads: unknown[], pageInfo?: { hasNextPage: boolean; endCursor: string | null }) =>
    JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: threads, ...(pageInfo ? { pageInfo } : {}) } } } },
    });

  test("counts the page and reports there are no more pages by default", () => {
    const page = parseBugbotThreadsPage(payload([thread(false, "cursor"), thread(true, "cursor")]));
    expect(page).toEqual({ count: 1, hasNextPage: false, endCursor: null });
  });

  test("surfaces pagination info when more pages remain", () => {
    const page = parseBugbotThreadsPage(
      payload([thread(false, "cursor")], { hasNextPage: true, endCursor: "Y3Vyc29y" }),
    );
    expect(page).toEqual({ count: 1, hasNextPage: true, endCursor: "Y3Vyc29y" });
  });

  test("returns null on malformed input", () => {
    expect(parseBugbotThreadsPage("not json")).toBeNull();
    expect(parseBugbotThreadsPage("{}")).toBeNull();
  });
});
