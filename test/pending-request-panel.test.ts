import { describe, expect, test } from "bun:test";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { createLoopState, type LoopState } from "../src/lib/state.ts";
import { createRunnerEventController } from "../src/opencode/step-runner-types.ts";
import { pendingRequestLines } from "../src/tui/pending-request-panel.ts";

const SID = "ses_active";

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
    controller.onPermissionAsked?.({ requestID: "per_1", sessionID: SID, permission: "edit", patterns: ["src/**"], metadata: {} });
    expect(state.pendingPermission).toMatchObject({ requestID: "per_1", permission: "edit", patterns: ["src/**"] });
    expect(replies).toEqual([]);
  });

  test("an 'ask' policy leaves the permission pending in state", () => {
    const state = makeState();
    const { controller, replies } = makeController(state, { permissionPolicy: { edit: "ask" } });
    controller.onPermissionAsked?.({ requestID: "per_1", sessionID: SID, permission: "edit", patterns: [], metadata: {} });
    expect(state.pendingPermission).toMatchObject({ requestID: "per_1" });
    expect(replies).toEqual([]);
  });

  test("a permission for another session is ignored", () => {
    const state = makeState();
    const { controller } = makeController(state);
    controller.onPermissionAsked?.({ requestID: "per_1", sessionID: "ses_other", permission: "edit", patterns: [], metadata: {} });
    expect(state.pendingPermission).toBeNull();
  });

  test("permission.replied clears the pending permission", () => {
    const state = makeState();
    const { controller } = makeController(state);
    controller.onPermissionAsked?.({ requestID: "per_1", sessionID: SID, permission: "edit", patterns: [], metadata: {} });
    controller.onPermissionReplied?.({ requestID: "per_1", sessionID: SID, reply: "once" });
    expect(state.pendingPermission).toBeNull();
  });
});

describe("pending question visibility", () => {
  test("a question under the default ask policy is surfaced in state without replying", () => {
    const state = makeState();
    const { controller, replies } = makeController(state);
    controller.onQuestionAsked?.({ requestID: "que_1", sessionID: SID, questions: [{ question: "Vanilla or chocolate?", header: "Flavor", options: [] }] });
    expect(state.pendingQuestion).toMatchObject({ requestID: "que_1" });
    expect(replies).toEqual([]);
  });

  test("questionPolicy reject still auto-rejects", async () => {
    const state = makeState();
    const { controller, replies } = makeController(state, { questionPolicy: "reject" });
    controller.onQuestionAsked?.({ requestID: "que_1", sessionID: SID, questions: [] });
    await Bun.sleep(0);
    expect(replies).toEqual(["que_1"]);
    expect(state.pendingQuestion).toBeNull();
  });
});

describe("pendingRequestLines", () => {
  test("is empty when nothing is pending", () => {
    expect(pendingRequestLines(makeState())).toEqual([]);
  });

  test("describes a pending permission with patterns and a policy hint", () => {
    const state = makeState();
    state.pendingPermission = { requestID: "per_1", sessionID: SID, permission: "edit", patterns: ["src/**"] };
    const text = pendingRequestLines(state).join("\n");
    expect(text).toContain("edit");
    expect(text).toContain("src/**");
    expect(text).toContain("permissionPolicy");
  });

  test("describes a pending question with its text and a policy hint", () => {
    const state = makeState();
    state.pendingQuestion = { requestID: "que_1", sessionID: SID, questions: [{ question: "Vanilla or chocolate?", header: "Flavor" }] };
    const text = pendingRequestLines(state).join("\n");
    expect(text).toContain("Vanilla or chocolate?");
    expect(text).toContain("questionPolicy");
  });
});
