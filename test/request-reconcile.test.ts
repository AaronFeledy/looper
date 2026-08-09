import { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, test } from "bun:test";

import { createLoopState, tryClaimPendingRequestDecision } from "../src/lib/state.ts";
import { createRequestBroker } from "../src/opencode/request-broker.ts";
import { reconcileOpenRequests } from "../src/opencode/request-reconcile.ts";

const SESSION_ID = "ses_reconcile";
const TOOL = { messageID: "msg-1", callID: "call-1" };

function permission(id: string) {
  return { id, sessionID: SESSION_ID, permission: "edit", patterns: [], metadata: {}, always: [], tool: TOOL };
}

function question(id: string) {
  return { id, sessionID: SESSION_ID, questions: [], tool: TOOL };
}

function harness(lists: { readonly permissions: () => Promise<unknown>; readonly questions: () => Promise<unknown> }) {
  const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
  const client = new OpencodeClient();
  Object.defineProperties(client, {
    permission: { value: { reply: async () => ({ data: true }), list: lists.permissions } },
    question: { value: { reject: async () => ({ data: true }), list: lists.questions } },
  });
  const lines: string[] = [];
  const broker = createRequestBroker({
    state,
    client,
    repoDir: "/repo",
    step: { name: "Build", prompt: "build" },
    activeSessionID: SESSION_ID,
    pushLine: (line) => lines.push(line),
    unattended: false,
    friction: { counts: new Map(), requestIDs: new Set() },
  });
  return { state, client, broker, lines };
}

describe("reconcileOpenRequests", () => {
  test("merges questions from question.list", async () => {
    // Given
    const target = harness({
      permissions: async () => ({ data: [] }),
      questions: async () => ({ data: [question("question-list")] }),
    });

    // When
    await reconcileOpenRequests({ client: target.client, repoDir: "/repo", broker: target.broker, pushLine: (line) => target.lines.push(line) });

    // Then
    expect(target.state.pendingRequests).toMatchObject([{ kind: "question", requestID: "question-list" }]);
  });


  test("preserves a claimed permission decision across reconcile of the same id", async () => {
    // Given an open permission the operator has already claimed.
    const target = harness({
      permissions: async () => ({ data: [permission("permission-open")] }),
      questions: async () => ({ data: [] }),
    });
    target.broker.callbacks.onPermissionAsked?.({ ...permission("permission-open"), requestID: "permission-open" });
    const claimed = tryClaimPendingRequestDecision(target.state, {
      requestID: "permission-open",
      generation: target.broker.generation,
      action: "once",
    });
    expect(claimed).toBe(true);

    // When event-stream resubscribe reconciles the still-open server list.
    await reconcileOpenRequests({
      client: target.client,
      repoDir: "/repo",
      broker: target.broker,
      pushLine: (line) => target.lines.push(line),
    });

    // Then the claim survives for the broker poller to consume.
    expect(target.state.pendingRequests).toMatchObject([
      { kind: "permission", requestID: "permission-open", status: "resolving", decision: "once" },
    ]);
  });

  test("preserves a claimed question decision across reconcile of the same id", async () => {
    // Given an open question the operator has already claimed.
    const target = harness({
      permissions: async () => ({ data: [] }),
      questions: async () => ({ data: [question("question-open")] }),
    });
    target.broker.callbacks.onQuestionAsked?.({ ...question("question-open"), requestID: "question-open" });
    const claimed = tryClaimPendingRequestDecision(target.state, {
      requestID: "question-open",
      generation: target.broker.generation,
      action: "reject",
    });
    expect(claimed).toBe(true);

    // When reconcile re-lists the same question.
    await reconcileOpenRequests({
      client: target.client,
      repoDir: "/repo",
      broker: target.broker,
      pushLine: (line) => target.lines.push(line),
    });

    // Then the claim is not reset to open.
    expect(target.state.pendingRequests).toMatchObject([
      { kind: "question", requestID: "question-open", status: "resolving", decision: "reject" },
    ]);
  });

  test("keeps the existing permission queue when permission.list fails", async () => {
    // Given
    const target = harness({
      permissions: async () => { throw new Error("list unavailable"); },
      questions: async () => ({ data: [] }),
    });
    target.broker.callbacks.onPermissionAsked?.({ ...permission("permission-open"), requestID: "permission-open" });

    // When
    await reconcileOpenRequests({ client: target.client, repoDir: "/repo", broker: target.broker, pushLine: (line) => target.lines.push(line) });

    // Then
    expect(target.state.pendingRequests).toMatchObject([{ kind: "permission", requestID: "permission-open" }]);
    expect(target.lines.filter((line) => line.includes("permission.list failed"))).toHaveLength(1);
  });
});
