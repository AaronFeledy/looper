import { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, test } from "bun:test";

import { createLoopStateStepReporter } from "../src/lib/loop-state-reporter.ts";
import { createLoopState } from "../src/lib/state.ts";
import { createRequestBrokerOwner } from "../src/opencode/request-broker-owner.ts";
import type { TeardownClock } from "../src/opencode/request-teardown.ts";

class FakeClock implements TeardownClock {
  readonly waits: Array<() => void> = [];
  sleep(): Promise<void> { return new Promise((resolve) => this.waits.push(resolve)); }
  expire(): void { for (const resolve of this.waits.splice(0)) resolve(); }
}

function ask(broker: { readonly callbacks: { onPermissionAsked?: (payload: { requestID: string; sessionID: string; permission: string; patterns: string[]; metadata: Record<string, unknown>; always: string[]; tool: { messageID: string; callID: string } }) => void } }, sessionID: string, requestID: string): void {
  broker.callbacks.onPermissionAsked?.({ requestID, sessionID, permission: "edit", patterns: ["src/**"], metadata: {}, always: [], tool: { messageID: "msg_1", callID: "call_1" } });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("createRequestBrokerOwner", () => {
  test("retains one broker and friction state while the same logical step waits", () => {
    // Given
    const friction = { counts: new Map<string, number>(), requestIDs: new Set<string>() };
    const owner = createRequestBrokerOwner({
      requests: createLoopStateStepReporter(createLoopState({ maxIterations: 1, stepNames: ["Build"] })).requests,
      client: new OpencodeClient(),
      repoDir: "/repo",
      step: { name: "Build", prompt: "build" },
      pushLine: () => undefined,
      unattended: false,
      friction,
    });

    // When
    const first = owner.bind("ses-waiting");
    friction.counts.set("edit", 1);
    const resumed = owner.bind("ses-waiting");

    // Then
    expect(resumed.broker).toBe(first.broker);
    expect(friction.counts.get("edit")).toBe(1);
  });

  test("carries unattended fail-closed rejects and friction across a broker recreation", async () => {
    // Given an unattended owner whose step rebinds to a second session mid-step.
    const replies: Array<{ readonly requestID: string; readonly reply?: string }> = [];
    const stops: string[] = [];
    const client = new OpencodeClient();
    Object.defineProperty(client, "permission", { value: {
      reply: async (call: { readonly requestID: string; readonly reply?: string }) => {
        replies.push(call);
        return { data: true };
      },
    } });
    const owner = createRequestBrokerOwner({
      requests: createLoopStateStepReporter(createLoopState({ maxIterations: 1, stepNames: ["Build"] })).requests,
      client,
      repoDir: "/repo",
      step: { name: "Build", prompt: "build" },
      pushLine: () => undefined,
      unattended: true,
      friction: { counts: new Map(), requestIDs: new Set() },
      writeStop: (reason) => stops.push(reason),
    });

    // When the same permission kind is asked twice on the first session and once on the second.
    const first = owner.bind("ses-first");
    ask(first.broker, "ses-first", "perm-1");
    ask(first.broker, "ses-first", "perm-2");
    const second = owner.bind("ses-second");
    ask(second.broker, "ses-second", "perm-3");
    await settle();

    // Then every ask is rejected and the shared friction count still trips at three.
    expect(second.broker).not.toBe(first.broker);
    expect(replies.map((call) => call.reply)).toEqual(["reject", "reject", "reject"]);
    expect(stops).toEqual(["permission friction: automated reject limit for 'edit'"]);
  });

  test("blocks a replacement broker after teardown cannot prove safety", async () => {
    // Given
    const clock = new FakeClock();
    const client = new OpencodeClient();
    Object.defineProperty(client, "session", { value: {
      abort: async () => await new Promise(() => undefined),
      status: async () => ({ data: { "ses-old": { type: "busy" } } }),
    } });
    const owner = createRequestBrokerOwner({
      requests: createLoopStateStepReporter(createLoopState({ maxIterations: 1, stepNames: ["Build"] })).requests,
      client,
      repoDir: "/repo",
      step: { name: "Build", prompt: "build" },
      pushLine: () => undefined,
      unattended: false,
      friction: { counts: new Map(), requestIDs: new Set() },
      teardownMs: 5,
      teardownClock: clock,
    });
    owner.bind("ses-old");

    // When
    const teardown = owner.teardown("ses-old");
    clock.expire();
    await teardown;

    // Then
    expect(() => owner.bind("ses-new")).toThrow("permission teardown timed out while aborting session");
  });
});
