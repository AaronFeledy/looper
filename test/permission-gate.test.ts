import { describe, expect, test } from "bun:test";

import type { PendingPermission, PendingQuestion } from "../src/lib/state.ts";
import {
  modalFocusWinner,
  permissionKeyAction,
  permissionModalLines,
  questionKeyAction,
  questionModalLines,
} from "../src/tui/permission-gate.ts";

const permission: PendingPermission = {
  requestID: "per_1",
  sessionID: "ses_1",
  permission: "edit",
  patterns: ["src/**/*.ts", "test/**/*.ts"],
  generation: 2,
};

const question: PendingQuestion = {
  requestID: "que_1",
  sessionID: "ses_1",
  questions: [{ header: "Deploy", question: "Proceed to production?" }],
  generation: 2,
};

describe("permissionModalLines", () => {
  test("shows the request details and attended choices when patterns are present", () => {
    // Given a permission request with affected patterns.
    // When its modal lines are built.
    const lines = permissionModalLines(permission);

    // Then the details precede every supported decision.
    expect(lines).toEqual([
      'Agent requests permission "edit"',
      "Patterns: src/**/*.ts, test/**/*.ts",
      "[y] once   [a] always   [d] deny   [s] deny + skip",
    ]);
  });

  test("omits the patterns line when the request has none", () => {
    // Given a permission request without patterns.
    const entry = { ...permission, patterns: [] };

    // When its modal lines are built.
    const lines = permissionModalLines(entry);

    // Then only the request and choices remain.
    expect(lines).toHaveLength(2);
  });
});

describe("questionModalLines", () => {
  test("shows question text and the attached-client hint", () => {
    // Given a structured question request.
    // When its modal lines are built.
    const lines = questionModalLines(question);

    // Then reject/skip are local and richer answers point to OpenCode.
    expect(lines).toEqual([
      "Deploy: Proceed to production?",
      "To answer with text or choose an option, use an attached OpenCode client.",
      "[d] reject   [s] skip",
    ]);
  });

  test("uses a stable fallback for an unrecognized question payload", () => {
    // Given a question payload without displayable text.
    const entry = { ...question, questions: [null, 42] };

    // When its modal lines are built.
    const lines = questionModalLines(entry);

    // Then the modal still explains why input is blocked.
    expect(lines[0]).toBe("Agent asked a question.");
  });
});

describe("permissionKeyAction", () => {
  test.each([
    ["y", "once"],
    ["Y", "once"],
    ["a", "always"],
    ["d", "reject"],
    ["s", "skip"],
    ["r", null],
    ["q", null],
    ["escape", null],
  ] as const)("maps %s to %s", (key, expected) => {
    // Given a normalized or printable key.
    // When the permission action is resolved.
    const action = permissionKeyAction(key);

    // Then only permission-decision keys produce an action.
    expect(action).toBe(expected);
  });
});

describe("questionKeyAction", () => {
  test.each([
    ["d", "reject"],
    ["D", "reject"],
    ["s", "skip"],
    ["y", null],
    ["q", null],
    ["escape", null],
  ] as const)("maps %s to %s", (key, expected) => {
    // Given a normalized or printable key.
    // When the question action is resolved.
    const action = questionKeyAction(key);

    // Then only reject and skip produce an action.
    expect(action).toBe(expected);
  });
});

describe("modalFocusWinner", () => {
  test.each([
    [{ recovery: true, escConfirm: true, permission: true, help: true, prompt: true, config: true }, "recovery"],
    [{ recovery: false, escConfirm: true, permission: true, help: true, prompt: true, config: true }, "escConfirm"],
    [{ recovery: false, escConfirm: false, permission: true, help: true, prompt: true, config: true }, "permission"],
    [{ recovery: false, escConfirm: false, permission: false, help: true, prompt: true, config: true }, "help"],
    [{ recovery: false, escConfirm: false, permission: false, help: false, prompt: true, config: true }, "prompt"],
    [{ recovery: false, escConfirm: false, permission: false, help: false, prompt: false, config: true }, "config"],
    [{ recovery: false, escConfirm: false, permission: false, help: false, prompt: false, config: false }, "none"],
  ] as const)("chooses %s as %s", (visible, expected) => {
    // Given every modal's visibility.
    const state = {
      recovery: visible.recovery ? { stepName: "build", reason: "failed" } : null,
      escConfirm: visible.escConfirm ? "stop" : null,
      pendingRequests: visible.permission
        ? [{ ...permission, kind: "permission", status: "open" as const }]
        : [],
      helpVisible: visible.help,
      promptModalVisible: visible.prompt,
      configModalVisible: visible.config,
    };

    // When the focus owner is selected.
    const winner = modalFocusWinner(state);

    // Then the highest-precedence visible modal wins.
    expect(winner).toBe(expected);
  });
});
