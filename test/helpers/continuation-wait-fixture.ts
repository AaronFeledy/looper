import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpencodeClient } from "@opencode-ai/sdk/v2";

import { initStatePaths } from "../../src/lib/state-files.ts";
import { createLoopState, type LoopState } from "../../src/lib/state.ts";

export const CONTINUATION_SESSION_ID = "ses_scenario_continuation";

export type ContinuationOutcome = "orphaned" | "idle" | "resumed";

export type ContinuationWaitFixture = {
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly sessionID: string;
  readonly state: LoopState;
  readonly cleanup: () => void;
};

export function continuationWaitFixture(outcome: ContinuationOutcome): ContinuationWaitFixture {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-registry-scenario-"));
  const configDir = join(repoDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });

  const updatedAt = outcome === "orphaned"
    ? new Date(Date.now() - 20 * 60 * 1_000).toISOString()
    : new Date().toISOString();
  const sourceState = outcome === "orphaned" ? "active" : "idle";
  const continuationDir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(continuationDir, { recursive: true });
  writeFileSync(
    join(continuationDir, `${CONTINUATION_SESSION_ID}.json`),
    JSON.stringify({
      sessionID: CONTINUATION_SESSION_ID,
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

  const client = new OpencodeClient();
  Object.defineProperty(client, "session", {
    value: {
      status: async () => ({
        data: {
          [CONTINUATION_SESSION_ID]: { type: outcome === "resumed" ? "busy" : "idle" },
        },
      }),
      children: async () => ({ data: [] }),
    },
  });

  return {
    client,
    repoDir,
    sessionID: CONTINUATION_SESSION_ID,
    state: createLoopState({ maxIterations: 1, stepNames: ["build"] }),
    cleanup: () => rmSync(repoDir, { recursive: true, force: true }),
  };
}
