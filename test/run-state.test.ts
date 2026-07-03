import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearRunStateFile,
  initStatePaths,
  readRunState,
  stepSessionsForResume,
  upsertStepSession,
  writeRunState,
} from "../src/lib/state-files.ts";

describe("run-state file", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "looper-run-state-"));
    initStatePaths({ configDir: scratch });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("returns null when no file exists", () => {
    expect(readRunState()).toBeNull();
  });

  test("round-trips an in-progress pointer with session + message", () => {
    writeRunState({ iteration: 3, stepIndex: 1, stepName: "review", sessionID: "ses_x", messageID: "msg_y" });
    const read = readRunState();
    expect(read).not.toBeNull();
    expect(read!.iteration).toBe(3);
    expect(read!.stepIndex).toBe(1);
    expect(read!.stepName).toBe("review");
    expect(read!.sessionID).toBe("ses_x");
    expect(read!.messageID).toBe("msg_y");
    expect(typeof read!.updatedAt).toBe("string");
  });

  test("omits session/message fields when advancing between steps", () => {
    writeRunState({ iteration: 2, stepIndex: 0, stepName: "build" });
    const read = readRunState();
    expect(read).not.toBeNull();
    expect(read!.sessionID).toBeUndefined();
    expect(read!.messageID).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(scratch, ".looper-run.json"), "utf8"));
    expect("sessionID" in onDisk).toBe(false);
    expect("messageID" in onDisk).toBe(false);
  });

  test("round-trips the iteration title so a resumed run can re-apply it", () => {
    writeRunState({ iteration: 2, stepIndex: 1, stepName: "review", title: "Widget X export" });
    expect(readRunState()!.title).toBe("Widget X export");
  });

  test("round-trips the looper run id used for session metadata", () => {
    writeRunState({ iteration: 2, stepIndex: 1, stepName: "review", looperRunID: "looper-run-test" });
    expect(readRunState()!.looperRunID).toBe("looper-run-test");
  });

  test("omits the title field entirely when no title is set", () => {
    writeRunState({ iteration: 1, stepIndex: 0, stepName: "build" });
    expect(readRunState()!.title).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(scratch, ".looper-run.json"), "utf8"));
    expect("title" in onDisk).toBe(false);
  });

  test("drops an empty-string title on read", () => {
    writeFileSync(
      join(scratch, ".looper-run.json"),
      JSON.stringify({ iteration: 1, stepIndex: 0, stepName: "build", title: "", updatedAt: "t" }),
    );
    expect(readRunState()!.title).toBeUndefined();
  });

  test("clearRunStateFile removes the pointer", () => {
    writeRunState({ iteration: 1, stepIndex: 0, stepName: "build" });
    expect(readRunState()).not.toBeNull();
    clearRunStateFile();
    expect(readRunState()).toBeNull();
  });

  test("rejects malformed / out-of-range records", () => {
    writeFileSync(join(scratch, ".looper-run.json"), JSON.stringify({ iteration: 0, stepIndex: 0, stepName: "x", updatedAt: "t" }));
    expect(readRunState()).toBeNull();
    writeFileSync(join(scratch, ".looper-run.json"), JSON.stringify({ iteration: 1, stepIndex: -1, stepName: "x", updatedAt: "t" }));
    expect(readRunState()).toBeNull();
    writeFileSync(join(scratch, ".looper-run.json"), JSON.stringify({ iteration: 1, stepIndex: 0, stepName: "", updatedAt: "t" }));
    expect(readRunState()).toBeNull();
    writeFileSync(join(scratch, ".looper-run.json"), "not json");
    expect(readRunState()).toBeNull();
  });

  test("round-trips stepSessions entries", () => {
    writeRunState({
      iteration: 2,
      stepIndex: 1,
      stepName: "review",
      stepSessions: [
        { stepIndex: 0, stepName: "build", sessionID: "ses_build" },
        { stepIndex: 1, stepName: "review", sessionID: "ses_review" },
      ],
    });
    const read = readRunState();
    expect(read).not.toBeNull();
    expect(read!.stepSessions).toEqual([
      { stepIndex: 0, stepName: "build", sessionID: "ses_build" },
      { stepIndex: 1, stepName: "review", sessionID: "ses_review" },
    ]);
  });

  test("old-format run-state file without stepSessions still parses (back-compat)", () => {
    writeFileSync(
      join(scratch, ".looper-run.json"),
      JSON.stringify({ iteration: 1, stepIndex: 0, stepName: "build", updatedAt: "t" }),
    );
    const read = readRunState();
    expect(read).not.toBeNull();
    expect(read!.stepSessions).toBeUndefined();
  });

  test("omits stepSessions from the on-disk JSON when not provided", () => {
    writeRunState({ iteration: 1, stepIndex: 0, stepName: "build" });
    const onDisk = JSON.parse(readFileSync(join(scratch, ".looper-run.json"), "utf8"));
    expect("stepSessions" in onDisk).toBe(false);
  });

  test("drops invalid stepSessions entries but keeps valid ones", () => {
    writeFileSync(
      join(scratch, ".looper-run.json"),
      JSON.stringify({
        iteration: 1,
        stepIndex: 0,
        stepName: "build",
        updatedAt: "t",
        stepSessions: [
          { stepIndex: 0, stepName: "build", sessionID: "ses_ok" },
          { stepIndex: -1, stepName: "bad", sessionID: "ses_bad" },
          { stepIndex: 1, stepName: "", sessionID: "ses_bad2" },
          { stepIndex: 2, stepName: "bad", sessionID: "" },
          { stepIndex: 1.5, stepName: "bad", sessionID: "ses_bad3" },
          "not-an-object",
          { stepIndex: 2, stepName: "review", sessionID: "ses_review" },
        ],
      }),
    );
    const read = readRunState();
    expect(read).not.toBeNull();
    expect(read!.stepSessions).toEqual([
      { stepIndex: 0, stepName: "build", sessionID: "ses_ok" },
      { stepIndex: 2, stepName: "review", sessionID: "ses_review" },
    ]);
  });

  test("treats a non-array stepSessions value as absent", () => {
    writeFileSync(
      join(scratch, ".looper-run.json"),
      JSON.stringify({ iteration: 1, stepIndex: 0, stepName: "build", updatedAt: "t", stepSessions: "bogus" }),
    );
    expect(readRunState()!.stepSessions).toBeUndefined();
  });
});

describe("upsertStepSession", () => {
  test("appends a new entry and keeps the list sorted by stepIndex", () => {
    const result = upsertStepSession(
      [{ stepIndex: 0, stepName: "build", sessionID: "ses_build" }],
      { stepIndex: 1, stepName: "review", sessionID: "ses_review" },
    );
    expect(result).toEqual([
      { stepIndex: 0, stepName: "build", sessionID: "ses_build" },
      { stepIndex: 1, stepName: "review", sessionID: "ses_review" },
    ]);
  });

  test("last-wins: replaces the existing entry for the same stepIndex", () => {
    const result = upsertStepSession(
      [
        { stepIndex: 0, stepName: "build", sessionID: "ses_build_1" },
        { stepIndex: 1, stepName: "review", sessionID: "ses_review" },
      ],
      { stepIndex: 0, stepName: "build", sessionID: "ses_build_2" },
    );
    expect(result).toEqual([
      { stepIndex: 0, stepName: "build", sessionID: "ses_build_2" },
      { stepIndex: 1, stepName: "review", sessionID: "ses_review" },
    ]);
  });

  test("does not mutate the input array", () => {
    const input = [{ stepIndex: 0, stepName: "build", sessionID: "ses_build" }];
    upsertStepSession(input, { stepIndex: 1, stepName: "review", sessionID: "ses_review" });
    expect(input).toEqual([{ stepIndex: 0, stepName: "build", sessionID: "ses_build" }]);
  });
});

describe("stepSessionsForResume", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "looper-run-state-resume-"));
    initStatePaths({ configDir: scratch });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("returns undefined when there is no run state", () => {
    expect(stepSessionsForResume(null, 2)).toBeUndefined();
  });

  test("returns undefined when the run state has no stepSessions", () => {
    writeRunState({ iteration: 2, stepIndex: 1, stepName: "review" });
    expect(stepSessionsForResume(readRunState(), 2)).toBeUndefined();
  });

  test("returns the persisted entries when the iteration matches", () => {
    writeRunState({
      iteration: 2,
      stepIndex: 1,
      stepName: "review",
      stepSessions: [{ stepIndex: 0, stepName: "build", sessionID: "ses_build" }],
    });
    expect(stepSessionsForResume(readRunState(), 2)).toEqual([{ stepIndex: 0, stepName: "build", sessionID: "ses_build" }]);
  });

  test("returns undefined when the recorded iteration does not match (stale state)", () => {
    writeRunState({
      iteration: 2,
      stepIndex: 1,
      stepName: "review",
      stepSessions: [{ stepIndex: 0, stepName: "build", sessionID: "ses_build" }],
    });
    expect(stepSessionsForResume(readRunState(), 3)).toBeUndefined();
  });
});
