import { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, test } from "bun:test";

import { createLoopState, tryClaimPendingRequestDecision, type LoopState } from "../src/lib/state.ts";
import { createRequestBroker, type RequestBroker, type RequestBrokerScheduler } from "../src/opencode/request-broker.ts";

const SESSION_ID = "ses_broker";
const REPO_DIR = "/repo";
const TOOL = { messageID: "msg_broker", callID: "call_broker" };

type Reply = { readonly requestID: string; readonly reply?: "once" | "always" | "reject"; readonly directory?: string };

class FakeClient {
  readonly client: OpencodeClient;
  readonly permissionReplies: Reply[] = [];
  readonly questionRejects: string[] = [];
  readonly outcomes: ("success" | "throw" | "already-resolved")[];

  constructor(outcomes: ("success" | "throw" | "already-resolved")[] = []) {
    this.outcomes = [...outcomes];
    const client = new OpencodeClient();
    Object.defineProperties(client, {
      permission: {
        value: {
          reply: async (input: Reply) => {
            this.permissionReplies.push(input);
            const outcome = this.outcomes.shift() ?? "success";
            if (outcome === "throw") throw new Error("transport unavailable");
            if (outcome === "already-resolved") return { error: { _tag: "PermissionNotFoundError", message: "gone" } };
            return { data: true };
          },
        },
      },
      question: {
        value: {
          reject: async ({ requestID }: { readonly requestID: string }) => {
            this.questionRejects.push(requestID);
            return { data: true };
          },
        },
      },
    });
    this.client = client;
  }
}

class FakeScheduler implements RequestBrokerScheduler {
  readonly timeouts = new Map<object, () => void>();
  readonly intervals = new Map<object, () => void>();

  setTimeout(callback: () => void): object {
    const handle = {};
    this.timeouts.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: object): void {
    this.timeouts.delete(handle);
  }

  setInterval(callback: () => void): object {
    const handle = {};
    this.intervals.set(handle, callback);
    return handle;
  }

  clearInterval(handle: object): void {
    this.intervals.delete(handle);
  }

  fireTimeouts(): void {
    const callbacks = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const callback of callbacks) callback();
  }
}

type Harness = {
  readonly state: LoopState;
  readonly fake: FakeClient;
  readonly broker: RequestBroker;
  readonly lines: string[];
  readonly stops: string[];
  readonly friction: { counts: Map<string, number>; requestIDs: Set<string> };
  readonly scheduler: FakeScheduler;
};

function harness(options: {
  readonly unattended?: boolean;
  readonly permissionPolicy?: Record<string, "ask" | "always" | "once" | "reject">;
  readonly questionPolicy?: "ask" | "reject";
  readonly outcomes?: ("success" | "throw" | "already-resolved")[];
} = {}): Harness {
  const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
  const fake = new FakeClient(options.outcomes);
  const lines: string[] = [];
  const stops: string[] = [];
  const friction = { counts: new Map<string, number>(), requestIDs: new Set<string>() };
  const scheduler = new FakeScheduler();
  const broker = createRequestBroker({
    state,
    client: fake.client,
    repoDir: REPO_DIR,
    step: { name: "Build", prompt: "build" },
    activeSessionID: SESSION_ID,
    pushLine: (line) => lines.push(line),
    unattended: options.unattended ?? false,
    friction,
    writeStop: (reason) => stops.push(reason),
    scheduler,
    ...(options.permissionPolicy === undefined ? {} : { permissionPolicy: options.permissionPolicy }),
    ...(options.questionPolicy === undefined ? {} : { questionPolicy: options.questionPolicy }),
  });
  return { state, fake, broker, lines, stops, friction, scheduler };
}

function askPermission(target: Harness, requestID: string, permission = "edit"): void {
  target.broker.callbacks.onPermissionAsked?.({
    requestID,
    sessionID: SESSION_ID,
    permission,
    patterns: ["src/**"],
    metadata: {},
    always: [],
    tool: TOOL,
  });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("createRequestBroker", () => {
  test("fails closed instead of sending always when unattended", async () => {
    const target = harness({ unattended: true, permissionPolicy: { edit: "always" } });

    askPermission(target, "perm-always");
    await settle();

    expect(target.fake.permissionReplies).toEqual([{ requestID: "perm-always", reply: "reject", directory: REPO_DIR }]);
    expect(target.lines.some((line) => line.includes("unattended_always_fail_closed"))).toBe(true);
    expect(target.friction.counts.get("edit")).toBe(1);
  });

  test("writes stop after three successful unattended ask rejects of one kind", async () => {
    const target = harness({ unattended: true });

    for (const requestID of ["perm-1", "perm-2", "perm-3"]) askPermission(target, requestID);
    await settle();

    expect(target.fake.permissionReplies).toHaveLength(3);
    expect(target.stops).toEqual(["permission friction: automated reject limit for 'edit'"]);
  });

  test("does not count human denials or configured reject policy", async () => {
    const target = harness();
    for (const requestID of ["human-1", "human-2", "human-3"]) {
      askPermission(target, requestID);
      expect(tryClaimPendingRequestDecision(target.state, { requestID, action: "reject", generation: target.broker.generation })).toBe(true);
      await target.broker.consumeDecisions();
    }
    const configured = harness({ permissionPolicy: { edit: "reject" } });
    askPermission(configured, "configured-1");
    await settle();

    expect(target.friction.counts.size).toBe(0);
    expect(configured.friction.counts.size).toBe(0);
  });

  test("handles two policy replies concurrently", async () => {
    const target = harness({ permissionPolicy: { edit: "once", bash: "reject" } });

    askPermission(target, "perm-edit", "edit");
    askPermission(target, "perm-bash", "bash");
    await settle();

    expect(target.fake.permissionReplies).toEqual([
      { requestID: "perm-edit", reply: "once", directory: REPO_DIR },
      { requestID: "perm-bash", reply: "reject", directory: REPO_DIR },
    ]);
  });

  test("succeeds on the single automatic retry", async () => {
    const target = harness({ permissionPolicy: { edit: "once" }, outcomes: ["throw", "success"] });

    askPermission(target, "perm-auto-retry");
    await settle();

    expect(target.fake.permissionReplies).toHaveLength(2);
    expect(target.state.pendingRequests).toEqual([]);
  });

  test("reopens with lastError after one retry and permits human reclaim", async () => {
    const target = harness({ outcomes: ["throw", "throw", "success"] });
    askPermission(target, "perm-retry");
    expect(tryClaimPendingRequestDecision(target.state, { requestID: "perm-retry", action: "once", generation: target.broker.generation })).toBe(true);

    await target.broker.consumeDecisions();
    expect(target.fake.permissionReplies).toHaveLength(2);
    expect(target.state.pendingRequests[0]).toMatchObject({ status: "open", lastError: "transport unavailable" });
    expect(tryClaimPendingRequestDecision(target.state, { requestID: "perm-retry", action: "once", generation: target.broker.generation })).toBe(true);
    await target.broker.consumeDecisions();

    expect(target.fake.permissionReplies).toHaveLength(3);
    expect(target.state.pendingRequests).toEqual([]);
  });

  test("dismisses replied and already-resolved requests", async () => {
    const replied = harness();
    askPermission(replied, "perm-external");
    replied.broker.callbacks.onPermissionReplied?.({ requestID: "perm-external", sessionID: SESSION_ID, reply: "once" });
    const resolved = harness({ permissionPolicy: { edit: "once" }, outcomes: ["already-resolved"] });
    askPermission(resolved, "perm-gone");
    await settle();

    expect(replied.state.pendingRequests).toEqual([]);
    expect(resolved.state.pendingRequests).toEqual([]);
  });

  test("rejects unattended questions and gate-timeout permissions", async () => {
    const question = harness({ unattended: true });
    question.broker.callbacks.onQuestionAsked?.({ requestID: "question-1", sessionID: SESSION_ID, questions: [], tool: TOOL });
    const timed = harness();
    askPermission(timed, "perm-timeout");
    timed.scheduler.fireTimeouts();
    await settle();

    expect(question.fake.questionRejects).toEqual(["question-1"]);
    expect(timed.fake.permissionReplies).toEqual([{ requestID: "perm-timeout", reply: "reject", directory: REPO_DIR }]);
    expect(timed.friction.counts.get("edit")).toBe(1);
  });

  test("dispose cancels all timers and pollers", () => {
    const target = harness();
    askPermission(target, "perm-open");

    target.broker.dispose();

    expect(target.scheduler.timeouts.size).toBe(0);
    expect(target.scheduler.intervals.size).toBe(0);
  });
});
