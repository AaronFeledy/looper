import { afterEach, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { checkSavedSessionOnStartup, resumePlanForSelection } from "../src/lib/startup-resume.ts";
import { cancelPendingNotify, createLoopState, createStepRow } from "../src/lib/state.ts";
import type { RunResumePlan } from "../src/engine/run-engine.ts";
import { bootResumeStatus } from "../src/presentation/tui/resume-status.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable } from "@opentui/core";
import { createResumeBanner } from "../src/tui/resume-banner.ts";
import { createStepList } from "../src/tui/step-list.ts";
import { createConstellationView } from "../src/tui/constellation.ts";

afterEach(cancelPendingNotify);
const plan = (): RunResumePlan => ({
  startIteration: 2, firstIterationStartStepIndex: 1, resumed: true, resetToFreshRun: false, looperRunID: "run_saved",
  firstIterationResume: { stepName: "review", sessionID: "ses_saved", messageID: "msg_saved", promptText: "Original review prompt", looperMessageIDs: ["msg_saved", "msg_continue"] },
  firstIterationTitle: "Implement export",
  firstIterationStepSessions: [{ stepIndex: 0, stepName: "build", sessionID: "ses_build" }, { stepIndex: 1, stepName: "review", sessionID: "ses_saved" }],
});
const stateForResume = () => createLoopState({ maxIterations: 5, stepNames: ["build", "review", "publish"] });
function mockClient({ parent = "busy", child = false, error = false, stale = false } = {}) {
  let statusReads = 0, writes = 0;
  const client = { session: {
    status: async () => { statusReads++; return error ? { error: { message: "unavailable" } } : { data: { ses_saved: { type: parent }, ses_child: { type: child ? "busy" : "idle" } } }; },
    messages: async () => ({ data: [{ info: { id: "msg_saved", role: "user", time: { created: stale ? 1 : Date.now() } }, parts: [] }] }),
    children: async () => ({ data: child ? [{ id: "ses_child", parentID: "ses_saved", time: { created: Date.now() } }] : [] }),
    create: async () => { writes++; }, prompt: async () => { writes++; }, abort: async () => { writes++; },
  } } as unknown as OpencodeClient;
  return { client, reads: () => statusReads, writes: () => writes };
}
async function inspect(state = stateForResume(), saved = plan(), mock = mockClient()) {
  const autoStart = await checkSavedSessionOnStartup({ state, plan: saved, client: mock.client, repoDir: "/tmp/looper-startup-resume-no-markers", fresh: false, timeoutMs: 30 });
  return { state, autoStart, mock };
}

test("confirmed active checkpoints request automatic reattachment without user input", async () => {
  const { state, autoStart, mock } = await inspect();
  expect(mock.reads()).toBeGreaterThan(0);
  expect(mock.writes()).toBe(0); // The engine owns actual reattachment.
  expect(autoStart).toBe(true);
  expect(state.started).toBe(false);
  expect(state.activeStepIndex).toBeNull();
  expect(state.selectedStepIndex).toBe(1);
  expect(state.steps[0]!.status).toBe("done");
  expect(state.steps[1]).toMatchObject({ status: "running", sessionID: "ses_saved", promptText: "Original review prompt" });
  expect(state.steps[1]!.statusMessage).toBeUndefined();
  expect(state.steps[2]!.status).toBe("pending");
  expect(bootResumeStatus(state)).toBeUndefined();
});

test("a quit requested during the probe prevents automatic reattachment", async () => {
  const state = stateForResume(), probe = mockClient();
  const originalStatus = probe.client.session.status;
  Object.defineProperty(probe.client.session, "status", { value: async () => {
    state.control.setQuitting(true);
    return originalStatus({});
  } });
  const result = await inspect(state, plan(), probe);
  expect(result.autoStart).toBe(false);
  expect(state.started).toBe(false);
});

test("finds a busy delegated child when its parent is idle and no continuation marker exists", async () => {
  const { state, autoStart } = await inspect(undefined, undefined, mockClient({ parent: "idle", child: true }));
  expect(state.bootResumeSession).toMatchObject({ workState: "running", canReattach: true });
  expect(autoStart).toBe(true);
});

test("idle, stale, and unknown checks are distinct and never auto-start", async () => {
  for (const [mock, workState] of [[mockClient({ parent: "idle" }), "idle"], [mockClient({ stale: true }), "stale"], [mockClient({ error: true }), "unknown"]] as const) {
    const { state, autoStart } = await inspect(undefined, undefined, mock);
    expect(state.bootResumeSession?.workState).toBe(workState);
    expect(autoStart).toBe(false);
    expect(state.steps[1]!.status).not.toBe("running");
    if (workState === "unknown") expect(bootResumeStatus(state)?.detail).toContain("may still be running");
    if (workState === "idle") expect(bootResumeStatus(state)).toBeUndefined();
  }
});

test("incomplete or mismatched checkpoints still reveal live work without allowing automatic reattachment", async () => {
  for (const patch of [{ messageID: undefined }, { stepName: "renamed-step" }]) {
    const saved = plan();
    const result = await inspect(undefined, { ...saved, firstIterationResume: { ...saved.firstIterationResume!, ...patch } }, undefined);
    expect(result.state.bootResumeSession).toMatchObject({ workState: "running", canReattach: false });
    expect(result.autoStart).toBe(false);
  }
});

test("fresh launches and already-started runs skip the startup probe", async () => {
  for (const started of [false, true]) {
    const state = stateForResume(), mock = mockClient();
    state.started = started;
    await checkSavedSessionOnStartup({ state, plan: plan(), client: mock.client, repoDir: "/tmp", fresh: !started, timeoutMs: 1 });
    expect(mock.reads()).toBe(0);
    expect(state.bootResumeSession).toBeUndefined();
  }
});

test("hung checks are bounded and late responses cannot paint replacement rows", async () => {
  const state = stateForResume();
  let resolveStatus!: (value: unknown) => void;
  const client = { session: { status: () => new Promise((resolve) => { resolveStatus = resolve; }) } } as unknown as OpencodeClient;
  const result = checkSavedSessionOnStartup({ state, plan: plan(), client, repoDir: "/tmp", fresh: false, timeoutMs: 5 });
  expect(state.bootResumeSession?.workState).toBe("checking");
  expect(await result).toBe(false);
  expect(state.bootResumeSession?.workState).toBe("unknown");
  state.steps[1] = createStepRow("replacement");
  resolveStatus({ data: { ses_saved: { type: "busy" } } });
  await Bun.sleep(10);
  expect(state.steps[1]!.status).toBe("pending");
  expect(state.steps[1]!.sessionID).toBeUndefined();
});

test("abort during startup cannot auto-start or publish a late observation", async () => {
  const state = stateForResume(), controller = new AbortController();
  const client = { session: { status: () => new Promise(() => {}) } } as unknown as OpencodeClient;
  const result = checkSavedSessionOnStartup({ state, plan: plan(), client, repoDir: "/tmp", fresh: false, timeoutMs: 50, signal: controller.signal });
  controller.abort();
  expect(await result).toBe(false);
  expect(state.bootResumeSession?.workState).toBe("checking");
});

test("selecting or inspecting the checkpoint preserves every resume field; other starts remain intentional", () => {
  const saved = plan();
  expect(resumePlanForSelection(saved, null)).toBe(saved);
  expect(resumePlanForSelection(saved, 1).firstIterationResume).toEqual(saved.firstIterationResume);
  expect(resumePlanForSelection(saved, 0)).toMatchObject({ firstIterationStartStepIndex: 0, resumed: false, firstIterationResume: undefined, firstIterationTitle: undefined, firstIterationStepSessions: undefined });
  expect(resumePlanForSelection(saved, 2)).toMatchObject({ firstIterationStartStepIndex: 2, resumed: true, firstIterationResume: undefined, firstIterationTitle: saved.firstIterationTitle });
});

for (const constellation of [false, true]) test(`${constellation ? "Constellation" : "classic"} UI shows the live saved step without a manual reattachment interface`, async () => {
  const { state } = await inspect();
  if (constellation) state.constellation = { reducedMotion: true, detailsOpen: false };
  const setup = await createTestRenderer({ width: 140, height: 34 });
  const root = new BoxRenderable(setup.renderer, { width: "100%", height: "100%", flexDirection: "column" });
  root.add(createResumeBanner(setup.renderer, state));
  root.add(constellation ? createConstellationView(setup.renderer, state) : createStepList(setup.renderer, state));
  setup.renderer.root.add(root);
  try {
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("Still running · review");
    expect(frame).not.toContain("reattach");
    expect(frame).not.toContain("press g");
    expect(frame).toContain("review");
    if (constellation) expect(frame).toContain("WORKING NOW");
  } finally { setup.renderer.destroy(); }
});

test("an unreadable child-session probe never proves an idle parent is safe to restart", async () => {
  const mock = mockClient({ parent: "idle" });
  Object.defineProperty(mock.client.session, "children", { value: async () => ({ error: { message: "children unavailable" } }) });
  const { state, autoStart } = await inspect(undefined, undefined, mock);
  expect(state.bootResumeSession?.workState).toBe("unknown");
  expect(autoStart).toBe(false);
  expect(mock.writes()).toBe(0);
});
