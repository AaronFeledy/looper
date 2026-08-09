import { describe, expect, test } from "bun:test";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { createLoopState, enqueuePendingPermission, enqueuePendingQuestion, type LoopState } from "../src/lib/state.ts";
import { createRunnerEventController } from "../src/opencode/step-runner-types.ts";
import { pendingRequestLines } from "../src/tui/pending-request-panel.ts";

const SID = "ses_active";
const TOOL = { messageID: "msg_active", callID: "call_active" };

function makeState(): LoopState {
  return createLoopState({ maxIterations: 3, stepNames: ["build"] });
}

function makeController(state: LoopState, options: { permissionPolicy?: Record<string, "always" | "once" | "reject" | "ask">; questionPolicy?: "ask" | "reject" } = {}) {
  const replies: string[] = [];
  const client = {
    permission: {
      reply: async ({ requestID }: { requestID: string }) => {
        replies.push(requestID);
        return {};
      },
    },
    question: {
      reject: async ({ requestID }: { requestID: string }) => {
        replies.push(requestID);
        return {};
      },
    },
  } as unknown as OpencodeClient;
  const controller = createRunnerEventController({
    state,
    client,
    repoDir: "/repo",
    step: { name: "Build", prompt: "/p.md" },
    activeSessionID: SID,
    pushLine: () => {},
    ...(options.permissionPolicy !== undefined ? { permissionPolicy: options.permissionPolicy } : {}),
    ...(options.questionPolicy !== undefined ? { questionPolicy: options.questionPolicy } : {}),
  });
  return { controller, replies };
}

describe("pending permission visibility", () => {
  test("a permission left pending (no policy) is surfaced in state", () => {
    const state = makeState();
    const { controller, replies } = makeController(state);
    controller.onPermissionAsked?.({ requestID: "per_1", sessionID: SID, permission: "edit", patterns: ["src/**"], metadata: {}, always: [], tool: TOOL });
    expect(state.pendingRequests[0]).toMatchObject({ requestID: "per_1", permission: "edit", patterns: ["src/**"], status: "open" });
    expect(replies).toEqual([]);
  });

  test("an 'ask' policy leaves the permission pending in state", () => {
    const state = makeState();
    const { controller, replies } = makeController(state, { permissionPolicy: { edit: "ask" } });
    controller.onPermissionAsked?.({ requestID: "per_1", sessionID: SID, permission: "edit", patterns: [], metadata: {}, always: [], tool: TOOL });
    expect(state.pendingRequests[0]).toMatchObject({ requestID: "per_1", status: "open" });
    expect(replies).toEqual([]);
  });

  test("a permission for another session is ignored", () => {
    const state = makeState();
    const { controller } = makeController(state);
    controller.onPermissionAsked?.({ requestID: "per_1", sessionID: "ses_other", permission: "edit", patterns: [], metadata: {}, always: [], tool: TOOL });
    expect(state.pendingRequests).toEqual([]);
  });

  test("permission.replied clears the pending permission", () => {
    const state = makeState();
    const { controller } = makeController(state);
    controller.onPermissionAsked?.({ requestID: "per_1", sessionID: SID, permission: "edit", patterns: [], metadata: {}, always: [], tool: TOOL });
    controller.onPermissionReplied?.({ requestID: "per_1", sessionID: SID, reply: "once" });
    expect(state.pendingRequests).toEqual([]);
  });
});

describe("pending question visibility", () => {
  test("a question under the default ask policy is surfaced in state without replying", () => {
    const state = makeState();
    const { controller, replies } = makeController(state);
    controller.onQuestionAsked?.({ requestID: "que_1", sessionID: SID, questions: [{ question: "Vanilla or chocolate?", header: "Flavor", options: [] }], tool: TOOL });
    expect(state.pendingRequests[0]).toMatchObject({ requestID: "que_1", status: "open" });
    expect(replies).toEqual([]);
  });

  test("questionPolicy reject still auto-rejects", async () => {
    const state = makeState();
    const { controller, replies } = makeController(state, { questionPolicy: "reject" });
    controller.onQuestionAsked?.({ requestID: "que_1", sessionID: SID, questions: [], tool: TOOL });
    await Bun.sleep(0);
    expect(replies).toEqual(["que_1"]);
    expect(state.pendingRequests).toEqual([]);
  });
});

describe("pendingRequestLines", () => {
  test("is empty when nothing is pending", () => {
    expect(pendingRequestLines(makeState())).toEqual([]);
  });

  test("describes a pending permission with patterns and a policy hint", () => {
    const state = makeState();
    enqueuePendingPermission(state, { requestID: "per_1", sessionID: SID, permission: "edit", patterns: ["src/**"], generation: 1 });
    const text = pendingRequestLines(state).join("\n");
    expect(text).toContain("edit");
    expect(text).toContain("src/**");
    expect(text).toContain("permissionPolicy");
  });

  test("describes a pending question with its text and a policy hint", () => {
    const state = makeState();
    enqueuePendingQuestion(state, {
      requestID: "que_1",
      sessionID: SID,
      questions: [{ question: "Vanilla or chocolate?", header: "Flavor" }],
      generation: 1,
    });
    const text = pendingRequestLines(state).join("\n");
    expect(text).toContain("Vanilla or chocolate?");
    expect(text).toContain("questionPolicy");
  });

  test("describes every queued request in order", () => {
    // Given
    const state = makeState();
    enqueuePendingPermission(state, { requestID: "per_1", sessionID: SID, permission: "edit", patterns: [], generation: 1 });
    enqueuePendingQuestion(state, {
      requestID: "que_1",
      sessionID: SID,
      questions: [{ question: "Continue?" }],
      generation: 1,
    });

    // When
    const lines = pendingRequestLines(state);

    // Then
    expect(lines[0]).toContain("edit");
    expect(lines[2]).toContain("Continue?");
  });
});
