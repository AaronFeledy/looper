import { ArrowScrollBoxRenderable } from "../src/tui/arrow-scroll-box.ts";
import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ScrollBoxRenderable } from "@opentui/core";
import { constellationAgents, layoutConstellation, selectConstellationAgent, toggleConstellationChildren } from "../src/presentation/tui/constellation.ts";
import { createConstellationView } from "../src/tui/constellation.ts";
import { createConstellationTransition, HANDOFF_DURATION_MS } from "../src/presentation/tui/constellation-transition.ts";
import { cancelPendingNotify, createBackgroundAgent, createLoopState, notify } from "../src/lib/state.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";
afterEach(cancelPendingNotify);

test("active descendants sit below parents; completed children fold into their parent", () => {
  const state = constellationFixture();
  for (const width of [32, 80, 106, 139, 240]) {
    const scene = layoutConstellation(constellationAgents(state), width);
    const root = scene.bubbles.find(b => b.node.id === "step:1")!;
    for (const child of scene.bubbles.filter(b => b.node.parentID)) {
      expect(child.node.lane).toBe("live");
      expect(scene.bubbles.some(b => b.node.id === "child:1:ses_explore")).toBe(false);
      if (child.node.status !== "idle") {
        const parent = scene.bubbles.find(b => b.node.id === child.node.parentID)!;
        expect(child.y).toBeGreaterThan(parent.y + parent.height);
        expect(child.height).toBeLessThan(root.height);
      }
    }
  }
});

test("large completed stacks never cover active descendants", () => {
  const state = constellationFixture();
  for (let i = 0; i < 30; i++) state.steps[1]!.backgroundAgents.push(
    createBackgroundAgent(`ses_idle${i}`, Date.now(), { activity: "idle", parentSessionID: "ses_build" }));
  // This idle parent still has a working grandchild and must remain in the tree.
  state.steps[1]!.backgroundAgents[0]!.activity = "idle";
  for (const width of [32, 80, 106, 139, 240]) {
    const scene = layoutConstellation(constellationAgents(state), width);
    const intermediary = scene.bubbles.find(b => b.node.id === "child:1:ses_components")!;
    const grandchild = scene.bubbles.find(b => b.node.id === "child:1:ses_keyboard")!;
    expect(intermediary.compact).toBe(false);
    expect(grandchild.y).toBeGreaterThan(intermediary.y + intermediary.height);
    for (const a of scene.bubbles) for (const b of scene.bubbles) {
      if (a === b) continue;
      expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
    }
  }
});

test("retiring a root moves all its children into the same trail family during handoff", () => {
  const state = constellationFixture();
  state.steps[1]!.backgroundAgents.forEach(agent => { agent.activity = "idle"; });
  const transition = createConstellationTransition(), options = { animate: true, scope: state.steps };
  toggleConstellationChildren(state);
  for (const child of constellationAgents(state).filter(node => node.parentID && node.completedCount)) toggleConstellationChildren(state, child);
  const before = layoutConstellation(constellationAgents(state), 139);
  transition.sample(before, 0, options);
  state.steps[1]!.status = "done"; state.steps[2]!.status = "running";
  const target = layoutConstellation(constellationAgents(state), 139);
  transition.sample(target, 100, options);
  const middle = transition.sample(target, 100 + HANDOFF_DURATION_MS / 2, options);
  const parent = target.bubbles.find(b => b.node.id === "step:1")!;
  expect(parent.region).toBe("pastHead");
  for (const child of target.bubbles.filter(b => b.node.stepIndex === 1 && b.node.parentID)) {
    expect(child.node.lane).toBe("past");
    expect(child.region).toBe("pastTail");
    expect(child.compact).toBe(true);
    expect(child.y).toBeGreaterThan(parent.y);
    const moving = middle.bubbles.find(b => b.node.id === child.node.id)!;
    expect(moving.traveling).toBe(true);
    expect(moving.x).toBeLessThan(before.bubbles.find(b => b.node.id === child.node.id)!.x);
    expect(moving.x).toBeGreaterThan(child.x);
  }
});

test("tail columns scroll independently while their top agents and the center stay fixed", async () => {
  const state = createLoopState({ maxIterations: 1, stepNames: Array.from({length: 18}, (_, i) => `agent ${i}`) });
  state.constellation = { detailsOpen: false, reducedMotion: true };
  state.started = true; state.activeStepIndex = 7; state.selectedStepIndex = 7;
  state.steps.forEach((step, i) => { step.status = i < 7 ? "done" : i === 7 ? "running" : "pending"; });
  state.steps[6]!.backgroundAgents = [createBackgroundAgent("ses_old", Date.now(), { agent: "old helper", activity: "idle" })];
  const setup = await createTestRenderer({width: 140, height: 30});
  const view = createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  try {
    await setup.flush();
    const left = view.findDescendantById("constellation-scroll-pastTail") as ScrollBoxRenderable;
    const right = view.findDescendantById("constellation-scroll-nextTail") as ScrollBoxRenderable;
    const center = view.findDescendantById("constellation-scroll-center") as ScrollBoxRenderable;
    expect(left).toBeInstanceOf(ArrowScrollBoxRenderable);
    expect(right).toBeInstanceOf(ArrowScrollBoxRenderable);
    for (const id of ["constellation-scroll-center", "constellation-field", "constellation-plan", "loop-agent-stream", "loop-step-list", "agent-inspector-text-pane"]) {
      const pane = view.findDescendantById(id);
      expect(pane).toBeInstanceOf(ScrollBoxRenderable);
      expect(pane).not.toBeInstanceOf(ArrowScrollBoxRenderable);
    }
    const hint = (pane: ScrollBoxRenderable, bottom: boolean) => setup.captureCharFrame().split("\n")[pane.y + (bottom ? pane.height - 1 : 0)]![pane.x + Math.floor((pane.width - 1) / 2)];
    for (const pane of [left, right]) {
      expect(hint(pane, false)).not.toBe("▲");
      expect(hint(pane, true)).toBe("▼");
      expect(pane.verticalScrollBar.visible).toBe(false);
    }
    const top = ["bubble-step:6", "bubble-step:7", "bubble-step:8"].map(id => view.findDescendantById(id)!);
    const ys = top.map(box => box.y);
    for (let i = 0; i < 4; i++) await setup.mockMouse.scroll(left.x + 4, left.y + 3, "down", {delayMs: 0});
    await Bun.sleep(60); await setup.flush();
    expect(left.scrollTop).toBeGreaterThan(0);
    expect(hint(left, false)).toBe("▲");
    expect(right.scrollTop).toBe(0);
    expect(center.scrollTop).toBe(0);
    expect(top.map(box => box.y)).toEqual(ys);
    const leftOffset = left.scrollTop;
    for (let i = 0; i < 4; i++) await setup.mockMouse.scroll(right.x + 4, right.y + 3, "down", {delayMs: 0});
    await Bun.sleep(60); await setup.flush();
    expect(right.scrollTop).toBeGreaterThan(0);
    expect(left.scrollTop).toBe(leftOffset);
    expect(top.map(box => box.y)).toEqual(ys);
    // Keyboard selection reveals a distant item in its own column only.
    const selected = constellationAgents(state).find(node => node.id === "step:0")!;
    selectConstellationAgent(state, selected); notify();
    await Bun.sleep(60); await setup.flush();
    const oldest = view.findDescendantById("bubble-step:0")!;
    expect(oldest.y).toBeGreaterThanOrEqual(left.viewport.y);
    expect(oldest.y + oldest.height).toBeLessThanOrEqual(left.viewport.y + left.viewport.height);
    expect(top.map(box => box.y)).toEqual(ys);
  } finally { setup.renderer.destroy(); }
});

for (const retired of [false, true]) test(`expanded child still opens its own output (${retired ? "trail" : "center"})`, async () => {
  const state = constellationFixture({withInspection: true});
  // Keep the target within the viewport in both layouts.
  state.steps[1]!.backgroundAgents.forEach(agent => { agent.activity = "idle"; });
  if (retired) { state.steps[1]!.status = "done"; state.steps[2]!.status = "running"; }
  toggleConstellationChildren(state);
  const setup = await createTestRenderer({width: 140, height: 34});
  const view = createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  try {
    await setup.flush();
    const chip = view.findDescendantById("bubble-child:1:ses_explore")!;
    expect(chip.height).toBe(retired ? 1 : 4);
    await setup.mockMouse.doubleClick(chip.x + 3, chip.y + (retired ? 0 : 1), 0, {delayMs: 0});
    await Bun.sleep(60); await setup.flush();
    expect(state.selectedBackgroundSessionID).toBe("ses_explore");
    expect(state.constellation?.detailsOpen).toBe(true);
    expect(setup.captureCharFrame()).toContain("Mapped the existing UI");
  } finally { setup.renderer.destroy(); }
});
