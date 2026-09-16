import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import {
  SIGNAL_LOG_FILE_NAME,
  appendSignal,
  clearSignalLog,
  readSignalsSince,
} from "../src/lib/signal-log.ts";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "signal-log-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("signal-log", () => {
  test("appends JSONL with mode 0600", () => {
    const dir = scratch();
    appendSignal(dir, { kind: "stop", reason: "operator" });
    const path = join(dir, SIGNAL_LOG_FILE_NAME);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const line = readFileSync(path, "utf8").trim();
    const record = JSON.parse(line);
    expect(record).toMatchObject({ kind: "stop", reason: "operator", at: expect.any(String) });
  });

  test("readSignalsSince filters by time and skips malformed lines", () => {
    const dir = scratch();
    const path = join(dir, SIGNAL_LOG_FILE_NAME);
    writeFileSync(
      path,
      [
        JSON.stringify({ at: "2020-01-01T00:00:00.000Z", kind: "stop", reason: "old" }),
        "not-json",
        JSON.stringify({ at: "not-a-date", kind: "stop", reason: "bad-date" }),
        JSON.stringify({ at: "2024-06-01T12:00:00.000Z", kind: "blocked", reason: "gate", storyId: "US-1" }),
        JSON.stringify({ at: "2024-06-01T13:00:00.000Z", kind: "story-phase", phase: "reviewed", storyId: "US-2" }),
        JSON.stringify({ kind: "stop" }), // missing at
        "",
      ].join("\n") + "\n",
    );

    const since = Date.parse("2024-06-01T00:00:00.000Z");
    const records = readSignalsSince(dir, since);
    expect(records).toEqual([
      { at: "2024-06-01T12:00:00.000Z", kind: "blocked", reason: "gate", storyId: "US-1" },
      { at: "2024-06-01T13:00:00.000Z", kind: "story-phase", phase: "reviewed", storyId: "US-2" },
    ]);
  });

  test("readSignalsSince returns empty for missing file", () => {
    expect(readSignalsSince(scratch(), 0)).toEqual([]);
  });

  test("append failures are diagnostic-only and never throw", () => {
    const dir = scratch();
    // Make the path a directory so appendFileSync fails.
    mkdirSync(join(dir, SIGNAL_LOG_FILE_NAME));
    const errors: string[] = [];
    expect(() =>
      appendSignal(dir, { kind: "no-op", reason: "x" }, (msg) => errors.push(msg)),
    ).not.toThrow();
    expect(errors[0]).toContain("signal log write failed");
  });

  test("clearSignalLog removes the file", () => {
    const dir = scratch();
    appendSignal(dir, { kind: "adjudicate", reason: "x" });
    clearSignalLog(dir);
    expect(readSignalsSince(dir, 0)).toEqual([]);
  });

  test("preserves 0600 after second append", () => {
    const dir = scratch();
    appendSignal(dir, { kind: "stop", reason: "a" });
    appendSignal(dir, { kind: "stop", reason: "b" });
    const mode = statSync(join(dir, SIGNAL_LOG_FILE_NAME)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readSignalsSince(dir, 0)).toHaveLength(2);
  });
});
