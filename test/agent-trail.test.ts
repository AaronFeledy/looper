import { OpencodeClient } from "@opencode-ai/sdk/v2";
import { createTestRenderer } from "@opentui/core/testing";
import { createConstellationView } from "../src/tui/constellation.ts";
import { completedSessionTimes } from "../src/lib/agent-trail-timing.ts";
import { userMessage, assistantMessage } from "./fixtures/session-messages.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentTrailStore } from "../src/persistence/agent-trail-store.ts";
import { createRunStateStore } from "../src/persistence/run-state-store.ts";
import { startAgentTrailPersistence } from "../src/lib/agent-trail.ts";
import { cancelPendingNotify, createBackgroundAgent, createLoopState, createStepRow, displayStepAt, displaySteps, flattenRows, setSelectedStepIndex, setSelectedStepOutputScroll, type LoopState } from "../src/lib/state.ts";
import { selectedInspectorTarget } from "../src/lib/agent-inspector-state.ts";
import { constellationAgents, layoutConstellation, selectConstellationAgent, toggleConstellationChildren, visibleConstellationAgents } from "../src/presentation/tui/constellation.ts";

const dirs: string[] = [];
afterEach(() => { cancelPendingNotify(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() {
  const base = join(import.meta.dir, ".tmp"); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "agent-trail-")); dirs.push(dir); return dir;
}
function state() { return createLoopState({ maxIterations: 10, stepNames: ["build", "review"] }); }
function finish(s: LoopState, sessionID: string, status: "done" | "failed" | "skipped" = "done") {
  s.iteration ||= 1;
  Object.assign(s.steps[0]!, { sessionID, status, startedAt: 100, finishedAt: 200,
    title: "A useful title", promptText: "Exact prompt", looperMessageIDs: ["msg_looper"],
    backgroundAgents: [createBackgroundAgent(`${sessionID}_child`, 110, { parentSessionID: sessionID, depth: 1, activity: "idle", title: "Review changes" })],
  });
}

test("completed agents remain visible through iteration replacement, and restore after process exit", () => {
  const dir = directory(); let current = state(); const trail = startAgentTrailPersistence(dir, () => current);
  finish(current, "ses_one"); trail.capture();
  expect(displaySteps(current)).toHaveLength(2); // no duplicate of the current row
  current.steps = [createStepRow("build"), createStepRow("review")]; current.iteration = 2;
  expect(displaySteps(current).map(([, step]) => step.sessionID)).toEqual(["ses_one", undefined, undefined]);
  finish(current, "ses_two", "failed"); trail.capture(); trail.stop();
  current = state();
  const reopened = startAgentTrailPersistence(dir, () => current);
  try {
    expect(current.retainedSteps.map(step => step.sessionID)).toEqual(["ses_one", "ses_two"]);
    expect(displayStepAt(current, -1)).toMatchObject({ status: "done", startedAt: 100, finishedAt: 200, promptText: "Exact prompt", looperMessageIDs: ["msg_looper"] });
    expect(displayStepAt(current, -1)?.backgroundAgents[0]).toMatchObject({ activity: "idle", parentSessionID: "ses_one", depth: 1, title: "Review changes" });
    expect(flattenRows(current)).toContainEqual({ kind: "step", stepIndex: -1 });
    const nodes = constellationAgents(current);
    expect(nodes.find(node => node.sessionID === "ses_two")?.lane).toBe("past");
    expect(layoutConstellation(nodes, 140).bubbles.filter(b => !b.node.parentID && b.node.lane === "past").map(b => b.node.sessionID)).toEqual(["ses_two", "ses_one"]);
    selectConstellationAgent(current, nodes.find(node => node.sessionID === "ses_one")!);
    expect(selectedInspectorTarget(current)?.step.sessionID).toBe("ses_one");
    expect(toggleConstellationChildren(current)).toBe(true);
    expect(visibleConstellationAgents(constellationAgents(current)).some(node => node.sessionID === "ses_one_child")).toBe(true);
    setSelectedStepIndex(current, -1); setSelectedStepOutputScroll(current, 7, false);
    expect(displayStepAt(current, -1)?.outputScrollTop).toBe(7);
    // Agent metadata is retained, transcript buffers stay out of the state file.
    expect(readFileSync(join(dir, ".looper-agents.json"), "utf8")).not.toContain("outputLines");
  } finally { reopened.stop(); }
});

test("resume pointer advancement and normal cleanup never clear the trail; explicit fresh does", () => {
  const dir = directory(), current = state(), pointer = createRunStateStore({ configDir: dir });
  const trail = startAgentTrailPersistence(dir, () => current);
  try {
    finish(current, "ses_done"); trail.capture();
    pointer.saveAdvance({ iteration: 1, steps: [{ name: "build" }], nextIndex: 1 });
    expect(pointer.read()).toMatchObject({ iteration: 2, stepIndex: 0 });
    pointer.clearRunArtifacts();
    expect(createAgentTrailStore(dir).read()).toHaveLength(1);
    trail.clear(); current.steps = [createStepRow("build")]; trail.capture();
    expect(current.retainedSteps).toEqual([]);
    expect(createAgentTrailStore(dir).read()).toEqual([]);
  } finally { trail.stop(); }
});

test("boot placeholders cannot overwrite saved timestamps, prompts, or children", () => {
  const dir = directory(); let current = state(); const trail = startAgentTrailPersistence(dir, () => current);
  finish(current, "ses_done"); trail.stop();
  current = state(); Object.assign(current.steps[0]!, { sessionID: "ses_done", status: "done", finishedAt: Date.now() });
  const restored = startAgentTrailPersistence(dir, () => current);
  try { expect(current.steps[0]).toMatchObject({ startedAt: 100, finishedAt: 200, promptText: "Exact prompt" }); expect(current.steps[0]?.backgroundAgents).toHaveLength(1); }
  finally { restored.stop(); }
});

test("headless state replacement carries the trail, with duplicate names kept distinct by session", () => {
  const dir = directory(); let current: LoopState | null = null;
  const trail = startAgentTrailPersistence(dir, () => current);
  try {
    current = state(); finish(current, "ses_a"); trail.capture();
    current = state(); current.iteration = 2; finish(current, "ses_b"); trail.capture();
    expect(current.retainedSteps.map(step => step.sessionID)).toEqual(["ses_a", "ses_b"]);
    current.steps[0]!.status = "running"; trail.capture();
    expect(createAgentTrailStore(dir).read().map(step => step.status)).toEqual(["done", "done"]);
  } finally { trail.stop(); }
});

test("missing, corrupt, and partially malformed files restore tolerantly", () => {
  const dir = directory(), store = createAgentTrailStore(dir), path = join(dir, ".looper-agents.json");
  expect(store.read()).toEqual([]);
  writeFileSync(path, "{"); expect(store.read()).toEqual([]);
  writeFileSync(path, JSON.stringify({ version: 1, agents: [null, { sessionID: "valid", name: "build", status: "done", iteration: 1, children: [null], looperMessageIDs: [1, "msg"] }, { sessionID: "busy", name: "build", status: "running", iteration: 1 }] }));
  expect(store.read()).toEqual([{ sessionID: "valid", name: "build", status: "done", iteration: 1, children: [], looperMessageIDs: ["msg"] }]);
});


test("legacy checkpoint times are recovered, persisted, and rendered after another restart", async () => {
  const dir = directory(); let current = state();
  Object.assign(current.steps[0]!, { name: "A very long completed agent title", status: "done", sessionID: "ses_legacy", finishedAt: Date.now() });
  const trail = startAgentTrailPersistence(dir, () => current);
  const client = new OpencodeClient(); let calls = 0;
  Object.defineProperty(client, "session", { value: { messages: async () => {
    calls++;
    return { data: [userMessage("ses_legacy", { time: { created: 1000 } }),
      assistantMessage("ses_legacy", { time: { created: 2000, completed: 61000 } })] };
  } } });
  try {
    // Boot-time placeholders are not persisted as real completion times.
    expect(createAgentTrailStore(dir).read()[0]?.finishedAt).toBeUndefined();
    await trail.recoverTimes(client, "/repo");
    expect(current.steps[0]).toMatchObject({ startedAt: 1000, finishedAt: 61000 });
    expect(createAgentTrailStore(dir).read()[0]).toMatchObject({ startedAt: 1000, finishedAt: 61000 });
    await trail.recoverTimes(client, "/repo"); expect(calls).toBe(1);
  } finally { trail.stop(); }
  current = state(); current.constellation = { detailsOpen: false, reducedMotion: true };
  const restored = startAgentTrailPersistence(dir, () => current);
  const setup = await createTestRenderer({ width: 140, height: 34 });
  const view = createConstellationView(setup.renderer, current); setup.renderer.root.add(view);
  try {
    await setup.flush();
    const box = view.findDescendantById("bubble-step:-1")!;
    const border = setup.captureCharFrame().split("\n")[box.y]!.slice(box.x, box.x + box.width);
    expect(border).not.toContain("1m");
    const title = view.findDescendantById("name-step:-1")!;
    const titleLine = setup.captureCharFrame().split("\n")[title.y]!.slice(title.x, title.x + title.width);
    expect(titleLine).toContain("... 1m");
    expect(titleLine.endsWith("1m")).toBe(true);
  } finally { setup.renderer.destroy(); restored.stop(); }
});

test("timing recovery rejects incomplete turns and ignores other sessions", () => {
  expect(completedSessionTimes("ses_old", [userMessage("ses_old"), assistantMessage("ses_old")])).toBeUndefined();
  expect(completedSessionTimes("ses_old", [assistantMessage("different", { time: { created: 1, completed: 2 } })])).toBeUndefined();
  expect(completedSessionTimes("ses_old", [assistantMessage("ses_old", { time: { created: 2, completed: 3 } }), userMessage("ses_old", { time: { created: 4 } })])).toBeUndefined();
});

test("late timing replies cannot restore records cleared by fresh start", async () => {
  const dir = directory(), current = state();
  Object.assign(current.steps[0]!, { status: "done", sessionID: "ses_old" });
  const trail = startAgentTrailPersistence(dir, () => current), client = new OpencodeClient();
  let reply!: (value: { data: ReturnType<typeof assistantMessage>[] }) => void;
  Object.defineProperty(client, "session", { value: { messages: () => new Promise(resolve => { reply = resolve; }) } });
  try {
    const recovering = trail.recoverTimes(client, "/repo");
    trail.clear(); current.steps = [createStepRow("build")];
    reply({ data: [assistantMessage("ses_old", { time: { created: 1000, completed: 61000 } })] });
    await recovering;
    expect(current.retainedSteps).toEqual([]); expect(createAgentTrailStore(dir).read()).toEqual([]);
  } finally { trail.stop(); }
});
