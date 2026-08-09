/**
 * Pinned SDK characterization: package.json uses @opencode-ai/sdk 1.18.10.
 * Verbatim from node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:
 *
 * permission.asked properties: {
 *   id: string;
 *   sessionID: string;
 *   permission: string;
 *   patterns: Array<string>;
 *   metadata: { [key: string]: unknown };
 *   always: Array<string>;
 *   tool?: { messageID: string; callID: string };
 * }
 * permission.replied properties: {
 *   sessionID: string;
 *   requestID: string;
 *   reply: "once" | "always" | "reject";
 * }
 * question.asked properties: {
 *   id: string;
 *   sessionID: string;
 *   questions: Array<QuestionInfo>;
 *   tool?: QuestionTool;
 * }
 * question.replied properties: {
 *   sessionID: string;
 *   requestID: string;
 *   answers: Array<QuestionAnswer>;
 * }
 * question.rejected properties: { sessionID: string; requestID: string };
 * permission.list response 200: Array<PermissionRequest>;
 * question.list response 200: Array<QuestionRequest>;
 *
 * Verbatim method parameters from dist/v2/gen/sdk.gen.d.ts:
 * permission.list(parameters?: { directory?: string; workspace?: string }, options?)
 * permission.reply(parameters: {
 *   requestID: string;
 *   directory?: string;
 *   workspace?: string;
 *   reply?: "once" | "always" | "reject";
 *   message?: string;
 * }, options?)
 * question.list(parameters?: { directory?: string; workspace?: string }, options?)
 * question.reject(parameters: {
 *   requestID: string;
 *   directory?: string;
 *   workspace?: string;
 * }, options?)
 */
import { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, test } from "bun:test";

import type { PermissionAction, PermissionPolicy } from "../src/lib/config.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";
import { createRunnerEventController } from "../src/opencode/step-runner-types.ts";

const ACTIVE_SESSION_ID = "ses_permission_active";
const REPO_DIR = "/repo";

type PermissionReplyCall = {
  readonly requestID: string;
  readonly directory?: string;
  readonly reply?: "once" | "always" | "reject";
};

type QuestionRejectCall = {
  readonly requestID: string;
  readonly directory?: string;
};

class FakeOpencodeClient {
  readonly client: OpencodeClient;
  readonly permissionReplies: PermissionReplyCall[] = [];
  readonly questionRejects: QuestionRejectCall[] = [];

  constructor(permissionReplyOutcome: "success" | "throw" = "success") {
    const client = new OpencodeClient();
    Object.defineProperties(client, {
      permission: {
        value: {
          reply: async (parameters: PermissionReplyCall) => {
            this.permissionReplies.push(parameters);
            if (permissionReplyOutcome === "throw") throw new Error("permission transport unavailable");
            return { data: true };
          },
        },
      },
      question: {
        value: {
          reject: async (parameters: QuestionRejectCall) => {
            this.questionRejects.push(parameters);
            return { data: true };
          },
        },
      },
    });
    this.client = client;
  }
}

type Harness = {
  readonly state: LoopState;
  readonly fake: FakeOpencodeClient;
  readonly lines: string[];
  readonly controller: ReturnType<typeof createRunnerEventController>;
};

function createHarness(options: {
  readonly permissionPolicy?: PermissionPolicy;
  readonly questionPolicy?: "ask" | "reject";
  readonly permissionReplyOutcome?: "success" | "throw";
} = {}): Harness {
  const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
  const fake = new FakeOpencodeClient(options.permissionReplyOutcome);
  const lines: string[] = [];
  const controller = createRunnerEventController({
    state,
    client: fake.client,
    repoDir: REPO_DIR,
    step: { name: "Build", prompt: "build" },
    activeSessionID: ACTIVE_SESSION_ID,
    pushLine: (line) => lines.push(line),
    ...(options.permissionPolicy === undefined ? {} : { permissionPolicy: options.permissionPolicy }),
    ...(options.questionPolicy === undefined ? {} : { questionPolicy: options.questionPolicy }),
  });
  return { state, fake, lines, controller };
}

function askPermission(harness: Harness, requestID = "perm-1", sessionID = ACTIVE_SESSION_ID): void {
  harness.controller.onPermissionAsked?.({
    requestID,
    sessionID,
    permission: "edit",
    patterns: ["src/**"],
    metadata: { source: "tool" },
    always: ["src/**"],
    tool: { messageID: "msg-1", callID: "call-1" },
  });
}

async function drainReplies(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

const AUTO_REPLY_ACTIONS = ["always", "once", "reject"] as const satisfies readonly Exclude<PermissionAction, "ask">[];

describe("createRunnerEventController permission characterization", () => {
  for (const action of AUTO_REPLY_ACTIONS) {
    test(`replies ${action} once when policy selects ${action}`, async () => {
      // Given
      const harness = createHarness({ permissionPolicy: { edit: action } });

      // When
      askPermission(harness);
      await drainReplies();

      // Then
      expect(harness.fake.permissionReplies).toEqual([{ requestID: "perm-1", reply: action, directory: REPO_DIR }]);
      expect(harness.lines.some((line) => line.includes("->"))).toBe(true);
    });
  }

  const askCases: readonly { readonly name: string; readonly permissionPolicy?: PermissionPolicy }[] = [
    { name: "no policy" },
    { name: "ask policy", permissionPolicy: { edit: "ask" } },
  ];

  for (const askCase of askCases) {
    test(`leaves permission pending with zero replies for ${askCase.name}`, () => {
      // Given
      const harness = createHarness(askCase.permissionPolicy === undefined ? {} : { permissionPolicy: askCase.permissionPolicy });

      // When
      askPermission(harness);

      // Then
      expect(harness.fake.permissionReplies).toEqual([]);
      expect(harness.state.pendingPermission).toEqual({
        requestID: "perm-1",
        sessionID: ACTIVE_SESSION_ID,
        permission: "edit",
        patterns: ["src/**"],
        metadata: { source: "tool" },
      });
      expect(harness.lines.some((line) => line.includes("left pending"))).toBe(true);
    });
  }

  test("ignores permission for a foreign session", () => {
    // Given
    const harness = createHarness({ permissionPolicy: { edit: "always" } });

    // When
    askPermission(harness, "perm-foreign", "ses_foreign");

    // Then
    expect(harness.fake.permissionReplies).toEqual([]);
    expect(harness.state.pendingPermission).toBeNull();
    expect(harness.lines).toEqual([]);
  });

  test("deduplicates a permission request while replying and after completion", async () => {
    // Given
    const harness = createHarness({ permissionPolicy: { edit: "once" } });

    // When
    askPermission(harness, "perm-duplicate");
    askPermission(harness, "perm-duplicate");
    await drainReplies();
    askPermission(harness, "perm-duplicate");

    // Then
    expect(harness.fake.permissionReplies).toEqual([{ requestID: "perm-duplicate", reply: "once", directory: REPO_DIR }]);
  });

  test("logs the current reply failure behavior", async () => {
    // Given
    const harness = createHarness({ permissionPolicy: { edit: "once" }, permissionReplyOutcome: "throw" });

    // When
    askPermission(harness, "perm-failure");
    await drainReplies();

    // Then
    expect(harness.fake.permissionReplies).toHaveLength(1);
    expect(harness.lines.some((line) => line.includes("reply failed: permission transport unavailable"))).toBe(true);
  });

  test("records question.reject when the current policy rejects", async () => {
    // Given
    const harness = createHarness({ questionPolicy: "reject" });

    // When
    harness.controller.onQuestionAsked?.({
      requestID: "question-1",
      sessionID: ACTIVE_SESSION_ID,
      questions: [],
      tool: { messageID: "msg-1", callID: "call-1" },
    });
    await drainReplies();

    // Then
    expect(harness.fake.questionRejects).toEqual([{ requestID: "question-1", directory: REPO_DIR }]);
  });
});
