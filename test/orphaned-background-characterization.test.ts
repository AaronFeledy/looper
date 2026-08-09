import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { waitForLoopContinuationIdle } from "../src/lib/runner.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, syncStepBackgroundAgents, type LoopState } from "../src/lib/state.ts";

const SESSION_ID = "ses_characterization";

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function freshRepo(): string {
  scratch = mkdtempSync(join(tmpdir(), "looper-orphan-characterization-"));
  const configDir = join(scratch, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  return scratch;
}

function writeContinuationRecord(repoDir: string, sourceState: "active" | "idle", updatedAt: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${SESSION_ID}.json`),
    JSON.stringify({
      sessionID: SESSION_ID,
      updatedAt,
      sources: {
        "background-task": {
          state: sourceState,
          ...(sourceState === "active" ? { reason: "active" } : {}),
          updatedAt,
        },
      },
    }),
  );
}

function fakeClient(status: "idle" | "busy" | "error"): OpencodeClient {
  return {
    session: {
      status: async () =>
        status === "error"
          ? { error: { message: "unavailable" } }
          : { data: { [SESSION_ID]: { type: status } } },
      children: async () => ({ data: [] }),
    },
  } as unknown as OpencodeClient;
}

function waitingState(): LoopState {
  const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
  state.activeStepIndex = 0;
  syncStepBackgroundAgents(state, 0, [{ sessionID: "ses_child", startedAt: 1 }]);
  return state;
}

function expectRegistryAgentRetained(state: LoopState): void {
  expect(state.steps[0]?.backgroundAgents.map(({ sessionID }) => sessionID)).toEqual(["ses_child"]);
}

describe("waitForLoopContinuationIdle characterization", () => {
  test("returns orphaned when a stale active record has an idle parent and no pending children", async () => {
    // Given
    const repoDir = freshRepo();
    writeContinuationRecord(repoDir, "active", new Date(Date.now() - 20 * 60 * 1_000).toISOString());
    const state = waitingState();

    // When
    const result = await waitForLoopContinuationIdle({ state, control: state.control, client: fakeClient("idle"), stepIndex: 0, repoDir, sessionID: SESSION_ID });

    // Then
    expect(result).toBe("orphaned");
    expectRegistryAgentRetained(state);
  });

  test("returns idle when the record and session status are idle", async () => {
    // Given
    const repoDir = freshRepo();
    writeContinuationRecord(repoDir, "idle", new Date().toISOString());
    const state = waitingState();

    // When
    const result = await waitForLoopContinuationIdle({ state, control: state.control, client: fakeClient("idle"), stepIndex: 0, repoDir, sessionID: SESSION_ID });

    // Then
    expect(result).toBe("idle");
    expectRegistryAgentRetained(state);
  });

  test("returns resumed when the record is idle but session status is busy", async () => {
    // Given
    const repoDir = freshRepo();
    writeContinuationRecord(repoDir, "idle", new Date().toISOString());
    const state = waitingState();

    // When
    const result = await waitForLoopContinuationIdle({ state, control: state.control, client: fakeClient("busy"), stepIndex: 0, repoDir, sessionID: SESSION_ID });

    // Then
    expect(result).toBe("resumed");
    expectRegistryAgentRetained(state);
  });

  for (const { expected, patch } of [
    { expected: "restart", patch: { restartRequested: true } },
    { expected: "skipped", patch: { skipRequested: true } },
    { expected: "stopped", patch: { quitting: true } },
  ] as const) {
    test(`returns ${expected} from the corresponding state flag before continuation polling`, async () => {
      // Given
      const repoDir = freshRepo();
      const state = waitingState();
      Object.assign(state, patch);

      // When
      const result = await waitForLoopContinuationIdle({ state, control: state.control, client: fakeClient("error"), stepIndex: 0, repoDir, sessionID: SESSION_ID });

      // Then
      expect(result).toBe(expected);
      expectRegistryAgentRetained(state);
    });
  }

  test("keeps waiting when session status cannot be read", async () => {
    // Given
    const repoDir = freshRepo();
    writeContinuationRecord(repoDir, "idle", new Date().toISOString());
    const state = waitingState();

    // When
    const result = await waitForLoopContinuationIdle({
      state,
      control: state.control,
      client: fakeClient("error"),
      stepIndex: 0,
      repoDir,
      sessionID: SESSION_ID,
      timeoutMs: -1,
    });

    // Then
    expect(result).toBe("timeout");
    // Registry projection owns these rows and prunes them when the step becomes terminal.
    expectRegistryAgentRetained(state);
  });
});
