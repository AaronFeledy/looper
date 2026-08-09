import { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, test } from "bun:test";

import { createLoopState } from "../src/lib/state.ts";
import { createRequestBrokerOwner } from "../src/opencode/request-broker-owner.ts";
import type { TeardownClock } from "../src/opencode/request-teardown.ts";

class FakeClock implements TeardownClock {
  readonly waits: Array<() => void> = [];
  sleep(): Promise<void> { return new Promise((resolve) => this.waits.push(resolve)); }
  expire(): void { for (const resolve of this.waits.splice(0)) resolve(); }
}

describe("createRequestBrokerOwner", () => {
  test("retains one broker and friction state while the same logical step waits", () => {
    // Given
    const friction = { counts: new Map<string, number>(), requestIDs: new Set<string>() };
    const owner = createRequestBrokerOwner({
      state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }),
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

  test("blocks a replacement broker after teardown cannot prove safety", async () => {
    // Given
    const clock = new FakeClock();
    const client = new OpencodeClient();
    Object.defineProperty(client, "session", { value: {
      abort: async () => await new Promise(() => undefined),
      status: async () => ({ data: { "ses-old": { type: "busy" } } }),
    } });
    const owner = createRequestBrokerOwner({
      state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }),
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
