import { createTestRenderer } from "@opentui/core/testing";
import { afterEach, describe, expect, test } from "bun:test";

import { permissionBellEnabled } from "../src/config/tunables.ts";
import {
  clearPendingRequest,
  createLoopState,
  enqueuePendingPermission,
  enqueuePendingQuestion,
  notify,
  type LoopState,
} from "../src/lib/state.ts";
import { createFooter } from "../src/tui/footer.ts";
import { helpLines } from "../src/tui/help-overlay.ts";
import { pendingRequestLines } from "../src/tui/pending-request-panel.ts";
import { BELL, createPermissionBell } from "../src/tui/permission-bell.ts";
import { createPermissionDialog } from "../src/tui/permission-dialog.ts";
import { bindKeys, type KeyHooks } from "../src/tui/keys.ts";

type KeyEventLike = { name?: string; ctrl?: boolean; sequence?: string; raw?: string; preventDefault?: () => void };

const BELL_ENV = "LOOPER_PERMISSION_BELL";
const originalBellEnv = process.env[BELL_ENV];

afterEach(() => {
  if (originalBellEnv === undefined) delete process.env[BELL_ENV];
  else process.env[BELL_ENV] = originalBellEnv;
});

function fakeRenderer(): { renderer: never; press: (key: KeyEventLike) => void } {
  const handlers: ((key: KeyEventLike) => void)[] = [];
  const renderer = {
    keyInput: {
      on: (_event: string, handler: (key: KeyEventLike) => void) => {
        handlers.push(handler);
      },
      off: () => {},
    },
    getSelection: () => null,
    copyToClipboardOSC52: () => true,
    clearSelection: () => {},
  };
  return {
    renderer: renderer as never,
    press: (key: KeyEventLike) => {
      for (const handler of handlers) handler(key);
    },
  };
}

function noopHooks(overrides: Partial<KeyHooks> = {}): KeyHooks {
  return {
    onEscape: () => {},
    onInterrupt: () => {},
    onQuit: () => {},
    onRecoveryChoice: () => {},
    onRestart: () => {},
    onSkip: () => {},
    onStart: () => {},
    onStopAfterIteration: () => {},
    onTogglePause: () => {},
    ...overrides,
  };
}

function makeState(): LoopState {
  return createLoopState({ maxIterations: 3, stepNames: ["build"] });
}

function gatedState(): LoopState {
  const state = makeState();
  enqueuePendingPermission(state, { requestID: "per_1", sessionID: "ses_1", permission: "edit", patterns: ["src/**"], generation: 4 });
  return state;
}

describe("permission gate keys", () => {
  test.each([
    ["y", "once"],
    ["a", "always"],
    ["d", "reject"],
    ["s", "skip"],
  ] as const)("%s claims the queued head as %s", (key, action) => {
    // Given a permission request gating the run.
    const state = gatedState();
    const fake = fakeRenderer();
    let skipCalls = 0;
    bindKeys(fake.renderer, state, noopHooks({ onSkip: () => { skipCalls += 1; } }));

    // When the operator presses the decision key.
    fake.press({ name: key });

    // Then the head is claimed with that action and the skip signal stays with the broker.
    expect(state.pendingRequests[0]).toMatchObject({ requestID: "per_1", status: "resolving", decision: action });
    expect(skipCalls).toBe(0);
  });

  test("q still quits while the gate is open", () => {
    // Given a permission request gating the run.
    const state = gatedState();
    const fake = fakeRenderer();
    let quitCalls = 0;
    bindKeys(fake.renderer, state, noopHooks({ onQuit: () => { quitCalls += 1; } }));

    // When quit is pressed.
    fake.press({ name: "q" });

    // Then the run quits and nothing was claimed.
    expect(quitCalls).toBe(1);
    expect(state.pendingRequests[0]).toMatchObject({ status: "open" });
  });

  test("a second decision key does not overwrite the first claim", () => {
    // Given a permission request already claimed by one keypress.
    const state = gatedState();
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());
    fake.press({ name: "y" });

    // When another decision key arrives before the broker consumes the claim.
    fake.press({ name: "d" });

    // Then the first decision stands.
    expect(state.pendingRequests[0]).toMatchObject({ status: "resolving", decision: "once" });
  });

  test("the next request is only claimable once the head leaves the queue", () => {
    // Given two queued requests with the head already claimed.
    const state = gatedState();
    enqueuePendingPermission(state, { requestID: "per_2", sessionID: "ses_1", permission: "bash", patterns: [], generation: 4 });
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());
    fake.press({ name: "y" });

    // When a key arrives while the claimed head is still queued.
    fake.press({ name: "d" });

    // Then the follower is untouched.
    expect(state.pendingRequests[1]).toMatchObject({ requestID: "per_2", status: "open" });
    expect(state.pendingRequests[1]?.decision).toBeUndefined();

    // When the head is resolved and the key repeats.
    clearPendingRequest(state, { requestID: "per_1", generation: 4 });
    fake.press({ name: "d" });

    // Then the follower takes the decision.
    expect(state.pendingRequests[0]).toMatchObject({ requestID: "per_2", status: "resolving", decision: "reject" });
  });

  test("a question head answers d and s only", () => {
    // Given a queued question.
    const state = makeState();
    enqueuePendingQuestion(state, { requestID: "que_1", sessionID: "ses_1", questions: [{ question: "Ship it?" }], generation: 2 });
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());

    // When an approval key is pressed.
    fake.press({ name: "y" });

    // Then nothing is claimed.
    expect(state.pendingRequests[0]).toMatchObject({ status: "open" });

    // When reject is pressed.
    fake.press({ name: "d" });

    // Then the question is claimed as a rejection.
    expect(state.pendingRequests[0]).toMatchObject({ status: "resolving", decision: "reject" });
  });

  test("the recovery menu outranks the gate", () => {
    // Given a failed step and a queued permission.
    const state = gatedState();
    state.recovery = { stepName: "build", reason: "failed" };
    const fake = fakeRenderer();
    const choices: string[] = [];
    bindKeys(fake.renderer, state, noopHooks({ onRecoveryChoice: (choice) => { choices.push(choice); } }));

    // When a recovery key is pressed.
    fake.press({ name: "r" });

    // Then recovery answers it and the gate is untouched.
    expect(choices).toEqual(["restart"]);
    expect(state.pendingRequests[0]).toMatchObject({ status: "open" });
  });

  test("an armed esc confirmation outranks the gate", () => {
    // Given a queued permission and a pending two-press stop confirmation.
    const state = gatedState();
    state.escConfirm = "stop";
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());

    // When a decision key is pressed.
    fake.press({ name: "y" });

    // Then it cancels the confirmation instead of claiming.
    expect(state.escConfirm).toBeNull();
    expect(state.pendingRequests[0]).toMatchObject({ status: "open" });
  });

  test("esc keeps opening the stop confirmation during the gate", () => {
    // Given a queued permission.
    const state = gatedState();
    const fake = fakeRenderer();
    let escapes = 0;
    bindKeys(fake.renderer, state, noopHooks({ onEscape: () => { escapes += 1; } }));

    // When esc is pressed.
    fake.press({ name: "escape" });

    // Then the escape hook runs and nothing is claimed.
    expect(escapes).toBe(1);
    expect(state.pendingRequests[0]).toMatchObject({ status: "open" });
  });

  test("a ctrl-modified decision key never claims", () => {
    // Given a queued permission.
    const state = gatedState();
    const fake = fakeRenderer();
    bindKeys(fake.renderer, state, noopHooks());

    // When ctrl is held with a decision key.
    fake.press({ ctrl: true, name: "y" });

    // Then the request stays open.
    expect(state.pendingRequests[0]).toMatchObject({ status: "open" });
  });

  test("unrelated keys are swallowed while the gate is open", () => {
    // Given a queued permission.
    const state = gatedState();
    const fake = fakeRenderer();
    let pauseCalls = 0;
    bindKeys(fake.renderer, state, noopHooks({ onTogglePause: () => { pauseCalls += 1; } }));

    // When run-control keys are pressed.
    fake.press({ name: "p" });
    fake.press({ name: "h" });

    // Then the gate holds them.
    expect(pauseCalls).toBe(0);
    expect(state.historyView).toBeNull();
  });
});

describe("permission bell", () => {
  test("rings once for each newly queued request on a TTY", async () => {
    // Given a bell attached to a TTY.
    const state = makeState();
    const writes: string[] = [];
    const stop = createPermissionBell(state, { enabled: true, isTTY: true, write: (text) => { writes.push(text); } });

    // When a request is queued and unrelated state changes follow.
    enqueuePendingPermission(state, { requestID: "per_1", sessionID: "ses_1", permission: "edit", patterns: [], generation: 1 });
    await Bun.sleep(60);
    state.paused = true;
    notify();
    await Bun.sleep(60);

    // Then exactly one bell was written.
    stop();
    expect(writes).toEqual([BELL]);
  });

  test("rings again after the same request id is asked a second time", async () => {
    // Given a bell that already announced a request.
    const state = makeState();
    const writes: string[] = [];
    const stop = createPermissionBell(state, { enabled: true, isTTY: true, write: (text) => { writes.push(text); } });
    enqueuePendingPermission(state, { requestID: "per_1", sessionID: "ses_1", permission: "edit", patterns: [], generation: 1 });
    await Bun.sleep(60);

    // When the request resolves and a later ask reuses the id.
    clearPendingRequest(state, { requestID: "per_1", generation: 1 });
    await Bun.sleep(60);
    enqueuePendingPermission(state, { requestID: "per_1", sessionID: "ses_1", permission: "edit", patterns: [], generation: 2 });
    await Bun.sleep(60);

    // Then the operator is alerted again.
    stop();
    expect(writes).toEqual([BELL, BELL]);
  });

  test.each([
    ["disabled", { enabled: false, isTTY: true }],
    ["not a TTY", { enabled: true, isTTY: false }],
  ] as const)("stays silent when %s", async (_label, output) => {
    // Given a bell that must not write.
    const state = makeState();
    const writes: string[] = [];
    const stop = createPermissionBell(state, { ...output, write: (text) => { writes.push(text); } });

    // When a request is queued.
    enqueuePendingPermission(state, { requestID: "per_1", sessionID: "ses_1", permission: "edit", patterns: [], generation: 1 });
    await Bun.sleep(60);

    // Then nothing reached the terminal.
    stop();
    expect(writes).toEqual([]);
  });

  test("stops ringing once detached", async () => {
    // Given a detached bell.
    const state = makeState();
    const writes: string[] = [];
    createPermissionBell(state, { enabled: true, isTTY: true, write: (text) => { writes.push(text); } })();

    // When a request is queued.
    enqueuePendingPermission(state, { requestID: "per_1", sessionID: "ses_1", permission: "edit", patterns: [], generation: 1 });
    await Bun.sleep(60);

    // Then the bell is silent.
    expect(writes).toEqual([]);
  });

  test.each([
    [undefined, true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["1", true],
  ] as const)("LOOPER_PERMISSION_BELL=%s resolves to %s", (value, expected) => {
    // Given the environment override.
    if (value === undefined) delete process.env[BELL_ENV];
    else process.env[BELL_ENV] = value;

    // When / Then the bell defaults on and only opts out explicitly.
    expect(permissionBellEnabled()).toBe(expected);
  });
});

describe("permission gate surfaces", () => {
  test("the help overlay documents the decision keys", () => {
    // Given the help overlay contents.
    const text = helpLines().join("\n");

    // When / Then every in-Looper decision key is listed.
    for (const needle of ["y", "a", "d", "s", "permission"]) expect(text).toContain(needle);
  });

  test("the footer shows the decision keys while a permission is queued", async () => {
    // Given a gated run rendered with the footer.
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 120, height: 3 });
    const state = gatedState();
    renderer.root.add(createFooter(renderer, state));

    // When the footer renders.
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();

    // Then the gate keys and quit are offered.
    expect(frame).toContain("[y] once");
    expect(frame).toContain("[s] deny + skip");
    expect(frame).toContain("[q]uit");
  });

  test("the panel summarizes the queue and its in-looper keys", () => {
    // Given two queued requests.
    const state = gatedState();
    enqueuePendingQuestion(state, { requestID: "que_1", sessionID: "ses_1", questions: [{ question: "Ship it?" }], generation: 4 });

    // When the panel lines are built.
    const lines = pendingRequestLines(state);
    const text = lines.join("\n");

    // Then both entries, the decision keys, and the queue depth are shown.
    expect(text).toContain("edit");
    expect(text).toContain("Ship it?");
    expect(text).toContain("[y] once");
    expect(text).toContain("[d] reject");
    expect(lines.at(-1)).toContain("2 requests waiting");
  });

  test("the dialog shows the head request and its keys", async () => {
    // Given a gated run rendered with the permission dialog.
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 20 });
    const state = gatedState();
    renderer.root.add(createPermissionDialog(renderer, state));

    // When the dialog renders.
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();

    // Then the request and every decision key are visible.
    expect(frame).toContain("edit");
    expect(frame).toContain("[y] once");
    expect(frame).toContain("[a] always");
  });

  test("the dialog hides while a higher-precedence modal owns focus", async () => {
    // Given a gated run whose step also failed.
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 20 });
    const state = gatedState();
    state.recovery = { stepName: "build", reason: "failed" };
    renderer.root.add(createPermissionDialog(renderer, state));

    // When the dialog renders.
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();

    // Then recovery keeps the screen.
    expect(frame).not.toContain("[y] once");
  });
});
