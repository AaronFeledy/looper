import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { resumeSessionWorkState } from "../src/lib/runner.ts";

const SESSION_ID = "ses_parent";

type StatusType = "idle" | "busy" | "retry";

type TestMessage = {
  readonly info: {
    readonly id: string;
    readonly role: "assistant";
    readonly time: {
      readonly created: number;
    };
  };
  readonly parts: readonly [];
};

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function freshRepo(): string {
  scratch = mkdtempSync(join(tmpdir(), "looper-resume-work-state-"));
  return scratch;
}

function writeFreshActiveContinuationRecord(repoDir: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${SESSION_ID}.json`),
    JSON.stringify({
      sessionID: SESSION_ID,
      updatedAt: now,
      sources: { "background-task": { state: "active", reason: "1 background task active", updatedAt: now } },
    }),
  );
}

function makeClient(messages: readonly TestMessage[]): OpencodeClient {
  return {
    session: {
      status: async () => ({ data: { [SESSION_ID]: { type: "busy" satisfies StatusType } } }),
      messages: async () => ({ data: messages }),
      children: async () => ({ data: [] }),
    },
  } as unknown as OpencodeClient;
}

function oldAssistantMessage(): TestMessage {
  return { info: { id: "msg_old", role: "assistant", time: { created: Date.now() - 10_000 } }, parts: [] };
}

describe("resumeSessionWorkState", () => {
  test("keeps a stale pending foreground session running when its continuation marker is freshly active", async () => {
    // Given: the parent session still reports busy, but foreground activity is old and no child sessions are pending.
    const repoDir = freshRepo();
    writeFreshActiveContinuationRecord(repoDir);
    const client = makeClient([oldAssistantMessage()]);

    // When: resume classification checks the saved session.
    const result = await resumeSessionWorkState({ client, repoDir, sessionID: SESSION_ID, staleBusyThresholdMs: 1_000 });

    // Then: the fresh active continuation marker keeps the session classified as running.
    expect(result).toBe("running");
  });
});
