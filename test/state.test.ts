import { afterEach, describe, expect, test } from "bun:test";

import {
  cancelPendingNotify,
  createLoopState,
  createStepRow,
  hydrateResumableBootStep,
  prdPassingGain,
  resetPrdIterationBaseline,
  setBranchDiffStatus,
  setPendingPermission,
  setPrdStatus,
  setPendingQuestion,
  setTodos,
  subscribe,
  type PendingPermission,
  type PrdStatus,
  type PendingQuestion,
  type TodoItem,
} from "../src/lib/state.ts";

afterEach(() => {
  cancelPendingNotify();
});

async function flushNotify(): Promise<void> {
  await Bun.sleep(50);
}

describe("createLoopState panel defaults", () => {
  test("initializes permission, question, and todo fields", () => {
    const state = createLoopState({ maxIterations: 3, stepNames: ["build"] });
    expect(state.pendingPermission).toBeNull();
    expect(state.pendingQuestion).toBeNull();
    expect(state.todos).toEqual([]);
    expect(state.prd).toEqual({ kind: "loading" });
    expect(state.prdIterationBaseline).toBeNull();
    expect(state.branchDiff).toEqual({ kind: "hidden" });
  });
});

describe("setBranchDiffStatus", () => {
  test("stores an ok status and notifies once", async () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });

    setBranchDiffStatus(state, { kind: "ok", additions: 12, deletions: 3, files: 4 });

    expect(state.branchDiff).toEqual({ kind: "ok", additions: 12, deletions: 3, files: 4 });
    await flushNotify();
    expect(calls).toBe(1);
  });

  test("suppresses notify for an identical status", async () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    setBranchDiffStatus(state, { kind: "ok", additions: 1, deletions: 1, files: 1 });
    await flushNotify();
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });

    setBranchDiffStatus(state, { kind: "ok", additions: 1, deletions: 1, files: 1 });

    await flushNotify();
    expect(calls).toBe(0);
  });
});

describe("setPrdStatus", () => {
  test("captures first ok status as the iteration baseline and notifies on status change", async () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });

    setPrdStatus(state, { kind: "ok", remaining: 13, total: 41 });

    expect(state.prd).toEqual({ kind: "ok", remaining: 13, total: 41 });
    expect(state.prdIterationBaseline).toBe(28);
    expect(prdPassingGain(state.prd, state.prdIterationBaseline)).toBe(0);
    await flushNotify();
    expect(calls).toBe(1);
  });

  test("captures baseline before returning for an identical ok status", async () => {
    const status: PrdStatus = { kind: "ok", remaining: 13, total: 41 };
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    state.prd = status;
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });

    setPrdStatus(state, status);

    expect(state.prdIterationBaseline).toBe(28);
    await flushNotify();
    expect(calls).toBe(0);
  });

  test("keeps the first baseline while later ok statuses report positive gain", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });

    setPrdStatus(state, { kind: "ok", remaining: 13, total: 41 });
    setPrdStatus(state, { kind: "ok", remaining: 10, total: 41 });

    expect(state.prdIterationBaseline).toBe(28);
    expect(prdPassingGain(state.prd, state.prdIterationBaseline)).toBe(3);
  });

  test("resetPrdIterationBaseline re-baselines current ok status without notifying", async () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    setPrdStatus(state, { kind: "ok", remaining: 13, total: 41 });
    setPrdStatus(state, { kind: "ok", remaining: 10, total: 41 });
    await flushNotify();
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });

    resetPrdIterationBaseline(state);

    expect(state.prdIterationBaseline).toBe(31);
    expect(prdPassingGain(state.prd, state.prdIterationBaseline)).toBe(0);
    await flushNotify();
    expect(calls).toBe(0);
  });

  test("gain is zero for non-ok status, null baseline, and passing regressions", () => {
    expect(prdPassingGain({ kind: "loading" }, 28)).toBe(0);
    expect(prdPassingGain({ kind: "error", message: "bad prd" }, 28)).toBe(0);
    expect(prdPassingGain({ kind: "ok", remaining: 13, total: 41 }, null)).toBe(0);
    expect(prdPassingGain({ kind: "ok", remaining: 16, total: 41 }, 28)).toBe(0);
  });

  test("resetPrdIterationBaseline clears baseline for non-ok status without notifying", async () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    setPrdStatus(state, { kind: "ok", remaining: 13, total: 41 });
    setPrdStatus(state, { kind: "error", message: "missing" });
    await flushNotify();
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });

    resetPrdIterationBaseline(state);

    expect(state.prdIterationBaseline).toBeNull();
    expect(prdPassingGain(state.prd, state.prdIterationBaseline)).toBe(0);
    await flushNotify();
    expect(calls).toBe(0);
  });
});

describe("setPendingPermission", () => {
  test("stores value and notifies subscribers", async () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    const permission: PendingPermission = {
      requestID: "req_perm",
      sessionID: "ses_1",
      permission: "edit",
      patterns: ["src/**"],
      metadata: { filepath: "src/foo.ts" },
    };
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });

    setPendingPermission(state, permission);
    expect(state.pendingPermission).toEqual(permission);

    await flushNotify();
    expect(calls).toBe(1);

    setPendingPermission(state, null);
    expect(state.pendingPermission).toBeNull();
    await flushNotify();
    expect(calls).toBe(2);
  });
});

describe("setPendingQuestion", () => {
  test("stores value and notifies subscribers", async () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    const question: PendingQuestion = {
      requestID: "req_q",
      sessionID: "ses_2",
      questions: [{ id: "q1", text: "Continue?" }],
    };
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });

    setPendingQuestion(state, question);
    expect(state.pendingQuestion).toEqual(question);
    await flushNotify();
    expect(calls).toBe(1);
  });
});

describe("setTodos", () => {
  test("stores list and notifies subscribers", async () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    const todos: TodoItem[] = [
      { content: "fix tests", status: "in_progress", priority: "high" },
      { content: "ship", status: "pending", priority: "low" },
    ];
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });

    setTodos(state, todos);
    expect(state.todos).toEqual(todos);
    await flushNotify();
    expect(calls).toBe(1);
  });
});

describe("hydrateResumableBootStep", () => {
  test("copies in-flight checkpoint fields onto a step row for pre-run TUI", () => {
    const step = createStepRow("review");

    hydrateResumableBootStep(step, {
      promptText: "persisted review prompt",
      sessionID: "ses_review",
      looperMessageIDs: ["msg_looper"],
      title: "Widget export",
    });

    expect(step.promptText).toBe("persisted review prompt");
    expect(step.sessionID).toBe("ses_review");
    expect(step.looperMessageIDs).toEqual(["msg_looper"]);
    expect(step.title).toBe("Widget export");
  });

  test("leaves unset checkpoint fields undefined", () => {
    const step = createStepRow("review");

    hydrateResumableBootStep(step, { promptText: "only prompt" });

    expect(step.promptText).toBe("only prompt");
    expect(step.sessionID).toBeUndefined();
    expect(step.looperMessageIDs).toBeUndefined();
    expect(step.title).toBeUndefined();
  });

  test("clones looperMessageIDs so later mutation of the checkpoint array is isolated", () => {
    const step = createStepRow("review");
    const ids = ["msg_a"];

    hydrateResumableBootStep(step, { looperMessageIDs: ids });
    ids.push("msg_b");

    expect(step.looperMessageIDs).toEqual(["msg_a"]);
  });
});
