import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { classifyAssistantWithReactivationGrace } from "../src/opencode/assistant-classification.ts";

const REPO = "/repo";
const SID = "ses_grace";
const PARENT = "msg_prompt";

type TestMessage = {
  readonly info: Record<string, unknown>;
  readonly parts: readonly Record<string, unknown>[];
};

type StatusOutcome = { readonly type: "idle" | "busy" | "retry" } | "error" | "throws";

type Fake = {
  readonly client: OpencodeClient;
  readonly counts: { status: number; messages: number };
};

function assistantEmpty(): TestMessage {
  return { info: { id: "asst_empty", role: "assistant", parentID: PARENT, time: { created: 1, completed: 2 }, tokens: { output: 0 } }, parts: [] };
}

function assistantDone(): TestMessage {
  return { info: { id: "asst_done", role: "assistant", parentID: PARENT, time: { created: 1, completed: 3 }, tokens: { output: 7 } }, parts: [{ type: "text", text: "real work" }] };
}

function assistantInProgress(): TestMessage {
  return { info: { id: "asst_live", role: "assistant", parentID: PARENT, time: { created: 1 }, tokens: { output: 0 } }, parts: [] };
}

/** Fake SDK client. `statuses`/`messages` are indexed by call number; the last entry repeats. */
function makeFake({ statuses, messages }: { statuses?: readonly StatusOutcome[]; messages: readonly (readonly TestMessage[])[] }): Fake {
  const counts = { status: 0, messages: 0 };
  const pick = <T>(list: readonly T[], call: number): T | undefined => list[Math.min(call - 1, list.length - 1)];

  const client = {
    session: {
      status: async () => {
        counts.status += 1;
        const outcome = pick(statuses ?? [{ type: "idle" as const }], counts.status) ?? { type: "idle" as const };
        if (outcome === "throws") throw new Error("status transport down");
        if (outcome === "error") return { error: { message: "status unavailable" } };
        return { data: { [SID]: outcome } };
      },
      messages: async () => {
        counts.messages += 1;
        return { data: pick(messages, counts.messages) ?? [] };
      },
    },
  } as unknown as OpencodeClient;

  return { client, counts };
}

const GRACE_KEYS = ["LOOPER_EMPTY_ASSISTANT_GRACE_MS", "LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS"] as const;
const savedEnv = new Map<string, string | undefined>();

describe("classifyAssistantWithReactivationGrace", () => {
  beforeEach(() => {
    for (const key of GRACE_KEYS) savedEnv.set(key, process.env[key]);
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  test("a non-empty classification returns immediately without probing session status", async () => {
    // Given a completed assistant message with real output and the default (10s) grace window
    const fake = makeFake({ messages: [[assistantDone()]] });

    // When
    const classification = await classifyAssistantWithReactivationGrace({ client: fake.client, repoDir: REPO, sessionID: SID, parentMessageID: PARENT });

    // Then the healthy path pays nothing: no wait, no status probe, one messages call
    expect(classification).toEqual({ kind: "done" });
    expect(fake.counts.status).toBe(0);
    expect(fake.counts.messages).toBe(1);
  });

  test("a session that goes busy during the window reports in-progress and stops polling early", async () => {
    // Given an empty assistant message and a session opencode revives on the second probe
    const fake = makeFake({ statuses: [{ type: "idle" }, { type: "busy" }], messages: [[assistantEmpty()]] });
    const logs: string[] = [];
    let reactivated = false;

    // When
    const classification = await classifyAssistantWithReactivationGrace({
      client: fake.client,
      repoDir: REPO,
      sessionID: SID,
      parentMessageID: PARENT,
      graceMs: 5_000,
      pollMs: 5,
      log: (line) => logs.push(line),
      onReactivated: () => {
        reactivated = true;
      },
    });

    // Then it hands off to the reattach path instead of exhausting the window
    expect(classification).toEqual({ kind: "in-progress" });
    expect(reactivated).toBe(true);
    expect(fake.counts.status).toBe(2);
    expect(logs).toEqual([`[looper] session ${SID} was reactivated by opencode after an empty assistant message; waiting for opencode instead of failing the step`]);
  });

  test("a session that stays idle for the whole window still classifies as empty", async () => {
    // Given an empty assistant message and a session that never comes back
    const fake = makeFake({ statuses: [{ type: "idle" }], messages: [[assistantEmpty()]] });

    // When
    const classification = await classifyAssistantWithReactivationGrace({ client: fake.client, repoDir: REPO, sessionID: SID, parentMessageID: PARENT, graceMs: 40, pollMs: 5 });

    // Then the original verdict survives, just later
    expect(classification).toEqual({ kind: "empty", errorMessage: "assistant message asst_empty completed without assistant output or tool activity" });
    expect(fake.counts.status).toBeGreaterThanOrEqual(2);
  });

  test("an assistant message that completes with real content during the window classifies as done", async () => {
    // Given the message history filling in on the second read
    const fake = makeFake({ statuses: [{ type: "idle" }], messages: [[assistantEmpty()], [assistantDone()]] });

    // When
    const classification = await classifyAssistantWithReactivationGrace({ client: fake.client, repoDir: REPO, sessionID: SID, parentMessageID: PARENT, graceMs: 5_000, pollMs: 5 });

    // Then
    expect(classification).toEqual({ kind: "done" });
    expect(fake.counts.messages).toBe(2);
  });

  test("a turn generating again while status still reads idle counts as reactivation", async () => {
    // Given the already-completed-empty turn turning back into an uncompleted (generating) turn
    // while the status probe has not caught up yet
    const fake = makeFake({ statuses: [{ type: "idle" }], messages: [[assistantEmpty()], [assistantInProgress()]] });
    const logs: string[] = [];
    let reactivated = false;

    // When
    const classification = await classifyAssistantWithReactivationGrace({
      client: fake.client,
      repoDir: REPO,
      sessionID: SID,
      parentMessageID: PARENT,
      graceMs: 5_000,
      pollMs: 5,
      log: (line) => logs.push(line),
      onReactivated: () => {
        reactivated = true;
      },
    });

    // Then the caller is told to hand off, so it cannot complete the step while opencode generates
    expect(classification).toEqual({ kind: "in-progress" });
    expect(reactivated).toBe(true);
    expect(logs).toEqual([`[looper] session ${SID} was reactivated by opencode after an empty assistant message; waiting for opencode instead of failing the step`]);
  });

  test("a failing session.status probe is never read as reactivation and never ends the wait", async () => {
    // Given a status endpoint that errors and then throws for the whole window
    const fake = makeFake({ statuses: ["error", "throws"], messages: [[assistantEmpty()]] });
    let reactivated = false;

    // When
    const classification = await classifyAssistantWithReactivationGrace({
      client: fake.client,
      repoDir: REPO,
      sessionID: SID,
      parentMessageID: PARENT,
      graceMs: 40,
      pollMs: 5,
      onReactivated: () => {
        reactivated = true;
      },
    });

    // Then the window is still honoured and the verdict is unchanged
    expect(classification.kind).toBe("empty");
    expect(reactivated).toBe(false);
    expect(fake.counts.status).toBeGreaterThanOrEqual(2);
  });

  test("shouldStop exits the wait immediately", async () => {
    // Given a stop request raised while the first poll interval is sleeping
    const fake = makeFake({ statuses: [{ type: "busy" }], messages: [[assistantEmpty()]] });
    const sleeps: number[] = [];
    let stopping = false;

    // When
    const classification = await classifyAssistantWithReactivationGrace({
      client: fake.client,
      repoDir: REPO,
      sessionID: SID,
      parentMessageID: PARENT,
      graceMs: 60_000,
      pollMs: 500,
      sleep: async (ms) => {
        sleeps.push(ms);
        stopping = true;
      },
      shouldStop: () => stopping,
    });

    // Then it returns the pre-wait verdict without probing status
    expect(classification.kind).toBe("empty");
    expect(sleeps).toEqual([500]);
    expect(fake.counts.status).toBe(0);
  });

  test("LOOPER_EMPTY_ASSISTANT_GRACE_MS=0 disables the wait entirely", async () => {
    // Given the disabling env override
    process.env.LOOPER_EMPTY_ASSISTANT_GRACE_MS = "0";
    const fake = makeFake({ statuses: [{ type: "busy" }], messages: [[assistantEmpty()]] });
    let slept = false;

    // When
    const classification = await classifyAssistantWithReactivationGrace({
      client: fake.client,
      repoDir: REPO,
      sessionID: SID,
      parentMessageID: PARENT,
      sleep: async () => {
        slept = true;
      },
    });

    // Then
    expect(classification.kind).toBe("empty");
    expect(slept).toBe(false);
    expect(fake.counts.status).toBe(0);
    expect(fake.counts.messages).toBe(1);
  });
});
