import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createRunStateStore, type RunStateStoreStep } from "../src/persistence/run-state-store.ts";

const STEPS: readonly RunStateStoreStep[] = [{ name: "build" }, { name: "review" }];

function readRunStateJson(configDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, ".looper-run.json"), "utf8"));
}

describe("run-state store", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "looper-run-state-store-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("writes an in-flight position with session and message fields", () => {
    const store = createRunStateStore({ configDir: scratch });

    store.savePosition({ iteration: 3, steps: STEPS, stepIndex: 1, sessionID: "ses_review", messageID: "msg_review" });

    expect(store.read()).toMatchObject({ iteration: 3, stepIndex: 1, stepName: "review", sessionID: "ses_review", messageID: "msg_review" });
    expect(Object.keys(readRunStateJson(scratch))).toEqual(["iteration", "stepIndex", "stepName", "sessionID", "messageID", "updatedAt"]);
  });

  test("advancing between steps drops in-flight session fields", () => {
    const store = createRunStateStore({ configDir: scratch });

    store.saveAdvance({ iteration: 2, steps: STEPS, nextIndex: 1, looperRunID: "run_1" });

    const onDisk = readRunStateJson(scratch);
    expect(onDisk).toMatchObject({ iteration: 2, stepIndex: 1, stepName: "review", looperRunID: "run_1" });
    expect("sessionID" in onDisk).toBe(false);
    expect("messageID" in onDisk).toBe(false);
    expect(Object.keys(onDisk)).toEqual(["iteration", "stepIndex", "stepName", "looperRunID", "updatedAt"]);
  });

  test("advancing within an iteration carries title and step sessions", () => {
    const store = createRunStateStore({ configDir: scratch });
    const stepSessions = [{ stepIndex: 0, stepName: "build", sessionID: "ses_build" }];

    store.saveAdvance({ iteration: 4, steps: STEPS, nextIndex: 1, title: "Widget export", looperRunID: "run_2", stepSessions });

    expect(readRunStateJson(scratch)).toMatchObject({
      iteration: 4,
      stepIndex: 1,
      stepName: "review",
      title: "Widget export",
      looperRunID: "run_2",
      stepSessions,
    });
  });

  test("advancing across an iteration boundary drops title and step sessions", () => {
    const store = createRunStateStore({ configDir: scratch });

    store.saveAdvance({
      iteration: 4,
      steps: STEPS,
      nextIndex: STEPS.length,
      title: "Widget export",
      looperRunID: "run_3",
      stepSessions: [{ stepIndex: 1, stepName: "review", sessionID: "ses_review" }],
    });

    const onDisk = readRunStateJson(scratch);
    expect(onDisk).toMatchObject({ iteration: 5, stepIndex: 0, stepName: "build", looperRunID: "run_3" });
    expect("title" in onDisk).toBe(false);
    expect("stepSessions" in onDisk).toBe(false);
    expect(Object.keys(onDisk)).toEqual(["iteration", "stepIndex", "stepName", "looperRunID", "updatedAt"]);
  });

  test("clearForFreshRun removes the run-state and legacy resume checkpoints", () => {
    const store = createRunStateStore({ configDir: scratch });
    store.savePosition({ iteration: 1, steps: STEPS, stepIndex: 0 });
    store.saveResumeStep(STEPS, 0);

    store.clearForFreshRun();

    expect(existsSync(join(scratch, ".looper-run.json"))).toBe(false);
    expect(existsSync(join(scratch, ".looper-resume-step.json"))).toBe(false);
  });
});
