import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createBackgroundAgent, createLoopState, cancelPendingNotify, notify } from "../src/lib/state.ts";
import { constellationAgents, layoutConstellation, visibleConstellationAgents, toggleConstellationChildren, selectConstellationAgent, moveConstellationSelection } from "../src/presentation/tui/constellation.ts";
import { createConstellationTransition, HANDOFF_DURATION_MS } from "../src/presentation/tui/constellation-transition.ts";
import { routeConstellationLinks } from "../src/presentation/tui/constellation-routing.ts";
import { createConstellationView } from "../src/tui/constellation.ts";
import { bindKeys, type KeyHooks } from "../src/tui/keys.ts";

afterEach(cancelPendingNotify);
const hooks: KeyHooks = { onEscape() {}, onInterrupt() {}, onQuit() {}, onRecoveryChoice() {}, onRestart() {}, onSkip() {}, onStart() {}, onStopAfterIteration() {}, onTogglePause() {} };
function fixture(retired = false) {
  const state = createLoopState({ maxIterations: 1, stepNames: ["earlier", "build", "review"] });
  state.constellation = { detailsOpen: false, reducedMotion: true };
  state.started = true; state.activeStepIndex = retired ? 2 : 1; state.selectedStepIndex = 1;
  state.steps[0]!.status = "done";
  state.steps[1]!.status = retired ? "done" : "running";
  state.steps[1]!.sessionID = "ses_root";
  if (retired) state.steps[2]!.status = "running";
  state.steps[1]!.backgroundAgents = [
    createBackgroundAgent("ses_parent", 1, { title: "Components", parentSessionID: "ses_root", activity: "idle" }),
    createBackgroundAgent("ses_leaf", 1, { title: "Prefix tests", parentSessionID: "ses_parent", activity: "idle" }),
    createBackgroundAgent("ses_sibling", 1, { title: "Docs", parentSessionID: "ses_root", activity: "idle" }),
  ];
  return state;
}
const nodesOf = (state: ReturnType<typeof fixture>) => constellationAgents(state);
const nodeOf = (state: ReturnType<typeof fixture>, id: string) => nodesOf(state).find(node => node.id === id)!;
const sceneOf = (state: ReturnType<typeof fixture>, width = 138) => layoutConstellation(nodesOf(state), width);
const visibleIDs = (state: ReturnType<typeof fixture>) => visibleConstellationAgents(nodesOf(state)).map(node => node.id);
const rootID = "step:1", parentID = "child:1:ses_parent", leafID = "child:1:ses_leaf";

test("completed descendants fold into their immediate parent, with independent remembered drawers", () => {
  const state = fixture();
  expect(nodeOf(state, rootID).completedCount).toBe(2);
  expect(nodeOf(state, parentID).completedCount).toBe(1);
  expect(visibleIDs(state)).not.toContain(parentID);
  toggleConstellationChildren(state);
  expect(visibleIDs(state)).toContain(parentID);
  expect(visibleIDs(state)).not.toContain(leafID);
  toggleConstellationChildren(state, nodeOf(state, parentID));
  expect(visibleIDs(state)).toContain(leafID);
  toggleConstellationChildren(state, nodeOf(state, rootID));
  expect(visibleIDs(state)).not.toContain(parentID);
  moveConstellationSelection(state, 1);
  expect(state.selectedBackgroundSessionID).toBeNull();
  toggleConstellationChildren(state, nodeOf(state, rootID));
  expect(visibleIDs(state)).toContain(leafID);
  for (const width of [16, 32, 80, 106, 138, 240]) {
    const scene = sceneOf(state, width);
    for (const a of scene.bubbles) {
      expect(a.x + a.width).toBeLessThanOrEqual(width);
      if (a.node.parentID) expect(a.prominence).toBe(0);
      for (const b of scene.bubbles) if (a !== b)
        expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
    }
  }
  state.steps = state.steps.map(step => ({ ...step, backgroundAgents: step.backgroundAgents.map(agent => ({ ...agent })) }));
  expect(nodeOf(state, rootID).expanded).toBe(false);
  expect(nodeOf(state, parentID).expanded).toBe(false);
});

test("running descendants and their idle ancestors remain visible through closed drawers", () => {
  const state = fixture();
  state.steps[1]!.backgroundAgents[1]!.activity = "busy";
  expect(visibleIDs(state)).toContain(parentID);
  expect(visibleIDs(state)).toContain(leafID);
  expect(nodeOf(state, rootID).completedCount).toBe(1);
  expect(nodeOf(state, parentID).completedCount).toBe(0);
  state.steps[1]!.backgroundAgents[1]!.activity = "idle";
  expect(visibleIDs(state)).not.toContain(parentID);
  expect(nodeOf(state, parentID).completedCount).toBe(1);
});

test("fold and unfold interpolate toward the parent and settle without ghost cards", () => {
  const state = fixture();
  state.steps[1]!.backgroundAgents[1]!.activity = "busy";
  const motion = createConstellationTransition(), options = { animate: true, scope: state.steps };
  const before = sceneOf(state); motion.sample(before, 0, options);
  state.steps[1]!.backgroundAgents[1]!.activity = "idle";
  const folded = sceneOf(state);
  motion.sample(folded, 100, options);
  const middle = motion.sample(folded, 100 + HANDOFF_DURATION_MS / 2, options);
  const original = before.bubbles.find(item => item.node.id === leafID)!;
  const moving = middle.bubbles.find(item => item.node.id === leafID)!;
  expect(moving.y).toBeLessThan(original.y);
  expect(moving.width).toBeLessThan(original.width);
  expect(motion.sample(folded, 100 + HANDOFF_DURATION_MS, options)).toEqual(folded);
  toggleConstellationChildren(state);
  const opened = sceneOf(state);
  const start = motion.sample(opened, 1000, options);
  const child = start.bubbles.find(item => item.node.id === parentID)!;
  expect(child.y).toBeLessThan(opened.bubbles.find(item => item.node.id === parentID)!.y);
  expect(child.width).toBe(3);
  expect(motion.sample(opened, 1000 + HANDOFF_DURATION_MS, options)).toEqual(opened);
});

test("Trail drawers slide below their parent; sidebar links are single separators outside descendants", () => {
  const state = fixture(true);
  const motion = createConstellationTransition(), options = { animate: true, scope: state.steps };
  const before = sceneOf(state); motion.sample(before, 0, options);
  toggleConstellationChildren(state);
  toggleConstellationChildren(state, nodeOf(state, parentID));
  const target = sceneOf(state);
  const start = motion.sample(target, 100, options);
  const middle = motion.sample(target, 100 + HANDOFF_DURATION_MS / 2, options);
  const child = target.bubbles.find(item => item.node.id === leafID)!;
  expect(middle.bubbles.find(item => item.node.id === leafID)!.y).toBeGreaterThan(start.bubbles.find(item => item.node.id === leafID)!.y);
  expect(middle.bubbles.find(item => item.node.id === leafID)!.y).toBeLessThan(child.y);
  const sidebar = { ...target, bubbles: target.bubbles.filter(item => item.node.lane === "past") };
  const links = routeConstellationLinks(sidebar, { geometry: "", paths: [] });
  expect(links).toHaveLength(1);
  expect(links[0]!.points).toHaveLength(1);
  const dot = links[0]!.points[0]!;
  expect(dot.y).toBeGreaterThan(Math.max(...sidebar.bubbles.filter(item => item.node.stepIndex === 1).map(item => item.y + item.height - 1)));
});

for (const retired of [false, true]) test("mouse and Tab toggle nested drawers in " + (retired ? "Trail" : "center"), async () => {
  const state = fixture(retired);
  const setup = await createTestRenderer({ width: 140, height: 34 });
  const view = createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  const unbind = bindKeys(setup.renderer, state, hooks);
  const flush = async () => { await Bun.sleep(60); await setup.flush(); };
  try {
    await setup.flush();
    expect(view.findDescendantById("bubble-" + parentID)).toBeUndefined();
    const meta = view.findDescendantById("meta-" + rootID)!;
    await setup.mockMouse.click(meta.x + 2, meta.y, 0, { delayMs: 0 }); await flush();
    expect(nodeOf(state, rootID).expanded).toBe(true);
    expect(view.findDescendantById("bubble-" + parentID)).toBeDefined();
    expect(view.findDescendantById("bubble-" + leafID)).toBeUndefined();
    selectConstellationAgent(state, nodeOf(state, parentID)); notify(); await flush();
    setup.mockInput.pressTab(); await flush();
    expect(nodeOf(state, parentID).expanded).toBe(true);
    expect(view.findDescendantById("bubble-" + leafID)).toBeDefined();
    expect(state.selectedBackgroundSessionID).toBe("ses_parent");
    if (retired) {
      const older = view.findDescendantById("bubble-step:0")!;
      expect(setup.captureCharFrame().split("\n")[older.y - 1]![older.x + Math.floor(older.width / 2)]).toBe("·");
    }
    // Toggle again by clicking the inline count (compact sidebar) or bottom row.
    const parent = view.findDescendantById("bubble-" + parentID)!;
    const nestedMeta = view.findDescendantById("meta-" + parentID)!;
    await setup.mockMouse.click(retired ? parent.x + parent.width - 3 : nestedMeta.x + 2,
      retired ? parent.y : nestedMeta.y, 0, { delayMs: 0 }); await flush();
    expect(nodeOf(state, parentID).expanded).toBe(false);
    expect(view.findDescendantById("bubble-" + leafID)).toBeUndefined();
    // Closing a selected parent leaves keyboard focus on that visible parent.
    selectConstellationAgent(state, nodeOf(state, rootID)); notify(); await flush();
    setup.mockInput.pressTab(); await flush();
    expect(view.findDescendantById("bubble-" + parentID)).toBeUndefined();
    expect(state.selectedBackgroundSessionID).toBeNull();
    expect(state.constellation!.detailsOpen).toBe(false);
  } finally { unbind(); setup.renderer.destroy(); }
});

test("native completion folds the selected descendant away and returns selection to a visible ancestor", async () => {
  const state = fixture();
  state.constellation!.reducedMotion = false;
  state.steps[1]!.backgroundAgents[1]!.activity = "busy";
  selectConstellationAgent(state, nodeOf(state, leafID));
  const setup = await createTestRenderer({ width: 140, height: 34 });
  const view = createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  try {
    await setup.flush();
    const child = view.findDescendantById("bubble-" + leafID)!;
    const original = { y: child.y, width: child.width };
    state.steps[1]!.backgroundAgents[1]!.activity = "idle"; notify();
    await Bun.sleep(240); await setup.flush();
    expect(child.width).toBeLessThan(original.width);
    expect(child.y).toBeLessThan(original.y);
    expect(state.selectedBackgroundSessionID).toBeNull();
    await Bun.sleep(HANDOFF_DURATION_MS); await setup.flush();
    expect(view.findDescendantById("bubble-" + leafID)).toBeUndefined();
    expect(view.findDescendantById("bubble-" + parentID)).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("▸ 2 sub agents");
  } finally { setup.renderer.destroy(); }
});
