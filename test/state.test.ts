import { afterEach, describe, expect, test } from "bun:test";

import {
  applyResumableBootUi,
  cancelPendingNotify,
  clearPendingRequest,
  consumePendingRequestDecision,
  createLoopState,
  createStepRow,
  enqueuePendingPermission,
  enqueuePendingQuestion,
  hydrateResumableBootStep,
  prdPassingGain,
  resetPrdIterationBaseline,
  setBranchDiffStatus,
  setPrdStatus,
  setTodos,
  subscribe,
  tryClaimPendingRequestDecision,
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
    expect(state.pendingRequests).toEqual([]);
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

describe("pending request queue", () => {
  test("stores multiple permission and question requests in arrival order", async () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    const permission: PendingPermission = {
      requestID: "req_perm",
      sessionID: "ses_1",
      permission: "edit",
      patterns: ["src/**"],
      metadata: { filepath: "src/foo.ts" },
      generation: 7,
    };
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });

    // When
    enqueuePendingPermission(state, permission);
    enqueuePendingQuestion(state, {
      requestID: "req_q",
      sessionID: "ses_2",
      questions: [{ id: "q1", text: "Continue?" }],
      generation: 7,
    });

    // Then
    expect(state.pendingRequests).toEqual([
      { kind: "permission", status: "open", ...permission },
      {
        kind: "question",
        status: "open",
        requestID: "req_q",
        sessionID: "ses_2",
        questions: [{ id: "q1", text: "Continue?" }],
        generation: 7,
      },
    ]);
    await flushNotify();
    expect(calls).toBe(1);
  });

  test("claims only the matching open head once", () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    const question: PendingQuestion = {
      requestID: "req_q",
      sessionID: "ses_2",
      questions: [{ id: "q1", text: "Continue?" }],
      generation: 3,
    };
    enqueuePendingQuestion(state, question);
    enqueuePendingPermission(state, {
      requestID: "req_perm",
      sessionID: "ses_1",
      permission: "edit",
      patterns: [],
      generation: 3,
    });

    // When
    const claimed = tryClaimPendingRequestDecision(state, { requestID: "req_q", action: "reject", generation: 3 });

    // Then
    expect(claimed).toBe(true);
    expect(state.pendingRequests[0]).toMatchObject({ requestID: "req_q", status: "resolving", decision: "reject" });
    expect(tryClaimPendingRequestDecision(state, { requestID: "req_q", action: "skip", generation: 3 })).toBe(false);
    expect(tryClaimPendingRequestDecision(state, { requestID: "req_perm", action: "once", generation: 3 })).toBe(false);
  });

  test("rejects a stale generation without changing the head", () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    enqueuePendingPermission(state, {
      requestID: "req_perm",
      sessionID: "ses_1",
      permission: "edit",
      patterns: [],
      generation: 9,
    });

    // When
    const claimed = tryClaimPendingRequestDecision(state, { requestID: "req_perm", action: "once", generation: 8 });

    // Then
    expect(claimed).toBe(false);
    expect(state.pendingRequests[0]).toMatchObject({ requestID: "req_perm", status: "open" });
  });

  test("consumes a claimed decision and clears a request by identity", () => {
    // Given
    const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
    enqueuePendingPermission(state, {
      requestID: "req_perm",
      sessionID: "ses_1",
      permission: "edit",
      patterns: [],
      generation: 4,
    });
    tryClaimPendingRequestDecision(state, { requestID: "req_perm", action: "always", generation: 4 });

    // When
    const decision = consumePendingRequestDecision(state, { requestID: "req_perm", generation: 4 });

    // Then
    expect(decision).toBe("always");
    expect(state.pendingRequests[0]).toMatchObject({ requestID: "req_perm", status: "resolving" });
    expect(consumePendingRequestDecision(state, { requestID: "req_perm", generation: 4 })).toBeNull();
    expect(clearPendingRequest(state, { requestID: "req_perm", generation: 4 })).toBe(true);
    expect(state.pendingRequests).toEqual([]);
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

describe("applyResumableBootUi", () => {
  test("marks prior steps done, hydrates the resume target, and selects it before start", () => {
    const state = createLoopState({ maxIterations: 5, stepNames: ["build", "review", "publish"] });

    applyResumableBootUi(state, {
      resumed: true,
      startIteration: 2,
      startStepIndex: 1,
      resume: {
        promptText: "continue review",
        sessionID: "ses_review",
        looperMessageIDs: ["msg_looper"],
      },
      title: "Widget export",
      stepSessions: [
        { stepIndex: 0, sessionID: "ses_build" },
        { stepIndex: 1, sessionID: "ses_review_stale" },
      ],
    });

    expect(state.resumable).toBe(true);
    expect(state.iteration).toBe(2);
    expect(state.selectedStepIndex).toBe(1);
    expect(state.selectedBackgroundSessionID).toBeNull();

    expect(state.steps[0]?.status).toBe("done");
    expect(state.steps[0]?.finishedAt).toBeDefined();
    expect(state.steps[0]?.sessionID).toBe("ses_build");
    expect(state.steps[0]?.title).toBe("Widget export");

    expect(state.steps[1]?.status).toBe("pending");
    expect(state.steps[1]?.promptText).toBe("continue review");
    expect(state.steps[1]?.sessionID).toBe("ses_review");
    expect(state.steps[1]?.looperMessageIDs).toEqual(["msg_looper"]);
    expect(state.steps[1]?.title).toBe("Widget export");

    expect(state.steps[2]?.status).toBe("pending");
    expect(state.steps[2]?.sessionID).toBeUndefined();
  });

  test("is a no-op when not resumed or already started", () => {
    const fresh = createLoopState({ maxIterations: 3, stepNames: ["a", "b"] });
    applyResumableBootUi(fresh, { resumed: false, startIteration: 1, startStepIndex: 1 });
    expect(fresh.resumable).toBe(false);
    expect(fresh.steps[0]?.status).toBe("pending");
    expect(fresh.selectedStepIndex).toBeNull();

    const started = createLoopState({ maxIterations: 3, stepNames: ["a", "b"] });
    started.started = true;
    applyResumableBootUi(started, { resumed: true, startIteration: 1, startStepIndex: 1 });
    expect(started.resumable).toBe(false);
    expect(started.steps[0]?.status).toBe("pending");
  });

  test("selects step 0 when resuming the first step of an iteration", () => {
    const state = createLoopState({ maxIterations: 3, stepNames: ["build", "review"] });

    applyResumableBootUi(state, {
      resumed: true,
      startIteration: 4,
      startStepIndex: 0,
      resume: { sessionID: "ses_build" },
    });

    expect(state.resumable).toBe(true);
    expect(state.iteration).toBe(4);
    expect(state.selectedStepIndex).toBe(0);
    expect(state.steps[0]?.sessionID).toBe("ses_build");
    expect(state.steps[0]?.status).toBe("pending");
    expect(state.steps[1]?.status).toBe("pending");
  });
});
