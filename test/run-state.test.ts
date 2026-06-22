import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearRunStateFile,
  initStatePaths,
  readRunState,
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
});
