import { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, test } from "bun:test";

import { createLoopState } from "../src/lib/state.ts";
import { createRequestBroker } from "../src/opencode/request-broker.ts";
import { teardownRequests, type TeardownClock } from "../src/opencode/request-teardown.ts";

const SESSION_ID = "ses_teardown";

class FakeClock implements TeardownClock {
  readonly waits: Array<() => void> = [];
  sleep(): Promise<void> {
    return new Promise((resolve) => this.waits.push(resolve));
  }
  expire(): void {
    for (const resolve of this.waits.splice(0)) resolve();
  }
}

function pendingPermission() {
  return {
    id: "perm-1",
    sessionID: SESSION_ID,
    permission: "edit",
    patterns: [],
    metadata: {},
    always: [],
    tool: { messageID: "msg-1", callID: "call-1" },
  };
}

function harness(options: { readonly abort?: () => Promise<unknown>; readonly reply?: () => Promise<unknown>; readonly list?: () => Promise<unknown> } = {}) {
  const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
  const client = new OpencodeClient();
  Object.defineProperties(client, {
    session: { value: {
      abort: options.abort ?? (async () => ({ data: true })),
      status: async () => ({ data: { [SESSION_ID]: { type: "idle" } } }),
    } },
    permission: { value: {
      reply: options.reply ?? (async () => ({ data: true })),
      list: options.list ?? (async () => ({ data: [pendingPermission()] })),
    } },
    question: { value: { reject: async () => ({ data: true }), list: async () => ({ data: [] }) } },
  });
  const broker = createRequestBroker({
    state,
    client,
    repoDir: "/repo",
    step: { name: "Build", prompt: "build" },
    activeSessionID: SESSION_ID,
    pushLine: () => undefined,
    unattended: false,
    friction: { counts: new Map(), requestIDs: new Set() },
  });
  broker.callbacks.onPermissionAsked?.({ ...pendingPermission(), requestID: "perm-1" });
  return { state, client, broker };
}

describe("teardownRequests", () => {
  test("returns unsafe when session abort hangs", async () => {
    // Given
    const target = harness({ abort: async () => await new Promise(() => undefined) });
    const clock = new FakeClock();

    // When
    const pending = teardownRequests({ client: target.client, repoDir: "/repo", sessionID: SESSION_ID, broker: target.broker, timeoutMs: 5, clock });
    clock.expire();

    // Then
    expect(await pending).toEqual({ safeToProceed: false, reason: "permission teardown timed out while aborting session" });
  });

  test("returns unsafe when rejecting an open request hangs", async () => {
    // Given
    const target = harness({ reply: async () => await new Promise(() => undefined) });
    const clock = new FakeClock();

    // When
    const pending = teardownRequests({ client: target.client, repoDir: "/repo", sessionID: SESSION_ID, broker: target.broker, timeoutMs: 5, clock });
    await Promise.resolve();
    await Promise.resolve();
    clock.expire();

    // Then
    expect((await pending).safeToProceed).toBe(false);
  });

  test("treats an externally resolved request during teardown as safe", async () => {
    // Given
    const target = harness({ list: async () => ({ data: [] }) });
    const clock = new FakeClock();

    // When
    const result = await teardownRequests({ client: target.client, repoDir: "/repo", sessionID: SESSION_ID, broker: target.broker, timeoutMs: 5, clock });

    // Then
    expect(result).toEqual({ safeToProceed: true });
    expect(target.state.pendingRequests).toEqual([]);
  });

  test("rejects each request id only once during teardown reconcile", async () => {
    // Given
    let replies = 0;
    const target = harness({ reply: async () => { replies += 1; return { data: true }; } });
    const clock = new FakeClock();

    // When
    const result = await teardownRequests({ client: target.client, repoDir: "/repo", sessionID: SESSION_ID, broker: target.broker, timeoutMs: 5, clock });

    // Then
    expect(result).toEqual({ safeToProceed: true });
    expect(replies).toBe(1);
  });
});
