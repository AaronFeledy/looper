import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import type { PermissionPolicy } from "../src/lib/config.ts";
import { runIteration } from "../src/lib/orchestrator.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths, readStopFile } from "../src/lib/state-files.ts";
import { createRunStateStore } from "../src/persistence/run-state-store.ts";

/**
 * The verbatim diagnosis an unattended run writes to the stop file once one
 * permission kind has been automatically rejected FRICTION_LIMIT times inside a
 * single logical step. Locked here on purpose: operators and stop-file readers
 * key off this text, so a reword is a breaking change, not a cosmetic one.
 */
const FRICTION_STOP_REASON = "permission friction: automated reject limit for 'edit'";

const SESSION_ID = "ses_unattended";

type PermissionReplyCall = { readonly requestID: string; readonly reply?: string; readonly directory?: string };

function setupScratch(): { readonly repoDir: string; readonly configDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-unattended-perm-"));
  const configDir = join(repoDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  writeFileSync(join(configDir, "build.md"), "build prompt body\n");
  writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    timeout: 1h\n");
  return { repoDir, configDir };
}

function writeIdleContinuationRecord(repoDir: string, sessionID: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${sessionID}.json`),
    JSON.stringify({ sessionID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
  );
}

function permissionAskedEvent(requestID: string, permission: string): Event {
  return {
    type: "permission.asked",
    properties: { id: requestID, sessionID: SESSION_ID, permission, patterns: ["src/**"], metadata: {}, always: [], tool: { messageID: "msg_1", callID: "call_1" } },
  } as unknown as Event;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
}

/**
 * Emits `asks` permission.asked events on the step's event stream, then holds the
 * prompt open until the broker has had its chance to answer them, so the
 * assertions observe a settled step rather than a race.
 */
function makeAskingClient(input: { readonly repoDir: string; readonly asks: readonly string[]; readonly expectedReplies: number }): {
  readonly client: OpencodeClient;
  readonly replies: PermissionReplyCall[];
} {
  const replies: PermissionReplyCall[] = [];
  let deliveredEvents!: () => void;
  const eventsDelivered = new Promise<void>((resolve) => { deliveredEvents = resolve; });
  const client = {
    session: {
      create: async () => ({ data: { id: SESSION_ID } }),
      prompt: async (params: { sessionID: string }) => {
        await eventsDelivered;
        await waitUntil(() => replies.length >= input.expectedReplies);
        await Bun.sleep(50);
        writeIdleContinuationRecord(input.repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { [SESSION_ID]: { type: "idle" } } }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    permission: {
      reply: async (call: PermissionReplyCall) => {
        replies.push(call);
        return { data: true };
      },
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<Event> {
          for (const requestID of input.asks) yield permissionAskedEvent(requestID, "edit");
          deliveredEvents();
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) return resolve();
            options.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
      }),
    },
  } as unknown as OpencodeClient;
  return { client, replies };
}

async function runOneStep(input: {
  readonly repoDir: string;
  readonly configDir: string;
  readonly client: OpencodeClient;
  readonly unattended?: boolean;
  readonly permissionPolicy?: PermissionPolicy;
}): Promise<{ readonly agentLines: readonly string[] }> {
  const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
  const store = createRunStateStore({ configDir: input.configDir });
  await runIteration({
    state,
    iteration: 1,
    client: input.client,
    repoDir: input.repoDir,
    configDir: input.configDir,
    ...(input.unattended !== undefined ? { unattended: input.unattended } : {}),
    writeStop: store.writeStop,
    ...(input.permissionPolicy !== undefined ? { permissionPolicy: input.permissionPolicy } : {}),
  });
  return { agentLines: state.agentLines };
}

describe("unattended permission handling", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("rejects asked permissions and writes the friction stop on the third of one kind", async () => {
    // Given an unattended step with no permission policy, so every ask resolves to `ask`.
    const { repoDir, configDir } = setupScratch();
    scratchDirs.push(repoDir);
    const stub = makeAskingClient({ repoDir, asks: ["perm-1", "perm-2", "perm-3"], expectedReplies: 3 });

    // When three edit permissions are asked inside that one step.
    await runOneStep({ repoDir, configDir, client: stub.client, unattended: true });

    // Then each ask is automatically rejected and the third writes the verbatim friction diagnosis.
    expect(stub.replies).toEqual([
      { requestID: "perm-1", reply: "reject", directory: repoDir },
      { requestID: "perm-2", reply: "reject", directory: repoDir },
      { requestID: "perm-3", reply: "reject", directory: repoDir },
    ]);
    expect(readStopFile()).toBe(FRICTION_STOP_REASON);
  });

  test("never sends always for a configured always policy while unattended", async () => {
    // Given an unattended step whose policy would grant a permanent allow.
    const { repoDir, configDir } = setupScratch();
    scratchDirs.push(repoDir);
    const stub = makeAskingClient({ repoDir, asks: ["perm-always"], expectedReplies: 1 });

    // When the permission is asked.
    const run = await runOneStep({ repoDir, configDir, client: stub.client, unattended: true, permissionPolicy: { edit: "always" } });

    // Then looper fails closed with a reject and says why, instead of granting.
    expect(stub.replies).toEqual([{ requestID: "perm-always", reply: "reject", directory: repoDir }]);
    expect(run.agentLines.some((line) => line.includes("unattended_always_fail_closed"))).toBe(true);
    expect(readStopFile()).toBeNull();
  });

  test("leaves asks pending for a human when the unattended flag is absent", async () => {
    // Given a step run without the unattended flag, as the TTY frontend does.
    const { repoDir, configDir } = setupScratch();
    scratchDirs.push(repoDir);
    const stub = makeAskingClient({ repoDir, asks: ["perm-1", "perm-2", "perm-3"], expectedReplies: 0 });

    // When the step runs.
    await runOneStep({ repoDir, configDir, client: stub.client });

    // Then nothing is auto-answered and no friction stop is written.
    expect(stub.replies).toEqual([]);
    expect(readStopFile()).toBeNull();
  });
});
