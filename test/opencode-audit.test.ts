import { OpencodeClient, type Event, type Session } from "@opencode-ai/sdk/v2";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopState } from "../src/lib/state.ts";
import { loopStateRunStepContext } from "../src/lib/loop-state-reporter.ts";
import { createRequestBrokerOwner } from "../src/opencode/request-broker-owner.ts";
import { createSessionEventConsumer } from "../src/lib/event-consumer.ts";
import { waitForActiveLoopContinuationRecord, waitForSessionLoopContinuationRecord } from "../src/opencode/background-tasks.ts";
import { classifyAssistantWithReactivationGrace } from "../src/opencode/assistant-classification.ts";
import { runOpenCodeStep } from "../src/opencode/step-runner.ts";
import { reattachOpenCodeStep } from "../src/opencode/reattach.ts";
import { sdkWithDeadline } from "../src/opencode/deadline.ts";
import { initStatePaths } from "../src/lib/state-files.ts";

const SID = "ses_audit";
function session(id: string, parentID: string): Session {
  return { id, parentID, slug: id, projectID: "project", directory: "/repo", title: id, version: "1", time: { created: 1, updated: 1 } };
}
const permission = (sessionID: string) => ({ id: `perm_${sessionID}`, sessionID, permission: "edit", patterns: [], metadata: {}, always: [] });
const empty = { info: { id: "assistant", role: "assistant", parentID: "msg_audit", time: { completed: 1 } }, parts: [] };

describe("integration audit regressions", () => {
  test("bootstraps transitive child requests into the same ownership used by events", async () => {
    // Given
    const client = new OpencodeClient();
    Object.defineProperties(client, {
      session: { value: { status: async () => ({ data: {} }), children: async ({ sessionID }: { sessionID: string }) => ({ data: sessionID === SID ? [session("child", SID)] : sessionID === "child" ? [session("grandchild", "child")] : [] }) } },
      permission: { value: { list: async () => ({ data: [permission("grandchild"), permission("foreign")] }) } },
      question: { value: { list: async () => ({ data: [] }) } },
    });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const ctx = loopStateRunStepContext(state, state.control);
    const owner = createRequestBrokerOwner({ client, requests: ctx.reporter.requests, repoDir: "/repo", step: { name: "Build", prompt: "" }, pushLine: () => undefined, unattended: false, friction: { counts: new Map(), requestIDs: new Set() } });
    const bound = owner.bind(SID);
    try {
      // When
      await owner.reconcile();
      // Then
      expect([...bound.ownedSessions.ids()]).toEqual([SID, "child", "grandchild"]);
      expect(state.pendingRequests.map((request) => request.sessionID)).toEqual(["grandchild"]);
    } finally { owner.dispose(); }
  });

  test("live lifecycle events discover descendants out of order and remove deleted subtrees", async () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const owner = createRequestBrokerOwner({ client: new OpencodeClient(), requests: loopStateRunStepContext(state, state.control).reporter.requests, repoDir: "/repo", step: { name: "Build", prompt: "" }, pushLine: () => undefined, unattended: false, friction: { counts: new Map(), requestIDs: new Set() } });
    const { broker, ownedSessions } = owner.bind(SID);
    const consumer = createSessionEventConsumer(SID, {
      pushLine: () => undefined, ...broker.callbacks,
      ownedSessionIDs: () => ownedSessions.ids(),
      onSessionLifecycle: (event) => {
        if (event.type === "session.deleted") ownedSessions.removeChild(event.properties.sessionID);
        else ownedSessions.apply({ kind: "upsert", session: { ...event.properties.info, createdAt: 1 } });
      },
    });
    try {
      // When
      await consumer.consume((async function* (): AsyncGenerator<Event> {
        yield { id: "event1", type: "session.created", properties: { sessionID: "grandchild", info: session("grandchild", "child") } };
        yield { id: "event2", type: "session.updated", properties: { sessionID: "child", info: session("child", SID) } };
        yield { id: "event3", type: "permission.asked", properties: permission("grandchild") };
        yield { id: "event4", type: "question.asked", properties: { id: "question", sessionID: "child", questions: [] } };
        yield { id: "event5", type: "session.deleted", properties: { sessionID: "child", info: session("child", SID) } };
        yield { id: "event6", type: "permission.asked", properties: { ...permission("grandchild"), id: "after-delete" } };
      })());
      // Then
      expect(state.pendingRequests.map((request) => request.requestID)).toEqual(["perm_grandchild", "question"]);
      expect([...ownedSessions.ids()]).toEqual([SID]);
    } finally { owner.dispose(); }
  });

  for (const status of ["pending", "unknown"] as const) {
    test(`continuation deadline returns ${status}, never completion`, async () => {
      // Given
      const repoDir = mkdtempSync(join(tmpdir(), "looper-grace-audit-"));
      const client = new OpencodeClient();
      Object.defineProperty(client, "session", { value: { status: async () => status === "pending" ? { data: { [SID]: { type: "busy" } } } : { error: "offline" } } });
      try {
        // When
        const outcomes = await Promise.all([
          waitForActiveLoopContinuationRecord({ client, repoDir, sessionID: SID, startedAt: Date.now(), graceMs: -1 }),
          waitForSessionLoopContinuationRecord({ client, repoDir, sessionID: SID, graceMs: -1 }),
        ]);
        // Then
        expect(outcomes).toEqual([status, status]);
      } finally { rmSync(repoDir, { recursive: true, force: true }); }
    });
  }

  test.each(["messages", "status"])("empty grace bounds a hung %s request", async (hung) => {
    // Given
    const client = new OpencodeClient();
    let reads = 0;
    Object.defineProperty(client, "session", { value: {
      messages: async () => { reads += 1; return hung === "messages" ? await new Promise(() => undefined) : { data: [empty] }; },
      status: async () => await new Promise(() => undefined),
    } });
    // When
    const result = await classifyAssistantWithReactivationGrace({ client, repoDir: "/repo", sessionID: SID, parentMessageID: "msg_audit", graceMs: 20, pollMs: 1 });
    // Then
    expect(["failed", "empty"]).toContain(result.kind);
    expect(reads).toBe(1);
  });

  test("a stop predicate interrupts a hung grace request", async () => {
    // Given
    const client = new OpencodeClient();
    let stop = false;
    Object.defineProperty(client, "session", { value: { messages: async () => { stop = true; return await new Promise(() => undefined); } } });
    // When
    const result = await classifyAssistantWithReactivationGrace({ client, repoDir: "/repo", sessionID: SID, parentMessageID: "msg_audit", graceMs: 60_000, shouldStop: () => stop });
    // Then
    expect(result.kind).toBe("failed");
  });

  test("shared deadline interrupts SDK calls that ignore their signal", async () => {
    // Given
    const controller = new AbortController();
    // When
    const pending = sdkWithDeadline(async () => { controller.abort(); return await new Promise(() => undefined); }, { remainingMs: 60_000, signal: controller.signal });
    // Then
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
  });

  test.each(["fresh", "reattach"])("%s retains its deadline through hung SDK calls", async (mode) => {
    // Given
    const client = new OpencodeClient();
    let statusCalls = 0;
    Object.defineProperties(client, {
      session: { value: {
        create: async () => ({ data: { id: SID } }), prompt: async () => ({ data: {} }), abort: async () => ({ data: true }),
        status: async () => { statusCalls += 1; return mode === "reattach" && statusCalls === 1 ? await new Promise(() => undefined) : { data: {} }; },
        children: async () => ({ data: [] }),
        messages: async () => mode === "fresh" ? await new Promise(() => undefined) : { data: [] },
      } },
      event: { value: { subscribe: async () => ({ stream: (async function* (): AsyncGenerator<Event> {})() }) } },
      permission: { value: { list: async () => ({ data: [] }) } },
      question: { value: { list: async () => ({ data: [] }) } },
    });
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const options = { client, ctx: loopStateRunStepContext(state, state.control), repoDir: "/repo", stepIndex: 0, step: { name: "Build", prompt: "", timeoutMs: 30 } };
    const configDir = mkdtempSync(join(tmpdir(), "looper-deadline-audit-"));
    initStatePaths({ configDir });
    // When
    const result = mode === "fresh" ? await runOpenCodeStep({ ...options, prompt: "build" }) : await reattachOpenCodeStep({ ...options, sessionID: SID, outcomeMessageID: "msg_audit" });
    // Then
    expect(["failed", "restart"]).toContain(result.status);
    rmSync(configDir, { recursive: true, force: true });
  });
});
