import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createConstellationTransition, HANDOFF_DURATION_MS } from "../src/presentation/tui/constellation-transition.ts";
import { constellationAgents, layoutConstellation, type ConstellationScene } from "../src/presentation/tui/constellation.ts";
import { constellationLinks, createConstellationView } from "../src/tui/constellation.ts";
import { stripAnsi } from "../src/lib/ansi.ts";
import { cancelPendingNotify, createLoopState, notify, type LoopState } from "../src/lib/state.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";

afterEach(cancelPendingNotify);
function advance(state: LoopState) {
  const index = state.activeStepIndex!;
  const current = state.steps[index]!;
  current.status = "done"; current.finishedAt = Date.now();
  current.backgroundAgents.forEach((agent) => { agent.activity = "idle"; agent.finishedAt = Date.now(); });
  state.activeStepIndex = index + 1 < state.steps.length ? index + 1 : null;
  if (state.activeStepIndex !== null) {
    state.steps[state.activeStepIndex]!.status = "running";
    state.selectedStepIndex = state.activeStepIndex;
  }
}
const sceneOf = (state: LoopState, width = 139) => layoutConstellation(constellationAgents(state), width);
const box = (scene: ConstellationScene, id: string) => scene.bubbles.find((bubble) => bubble.node.id === id)!;

test("flow links stay dotted without changing delegation lines", () => {
  const state = createLoopState({ maxIterations: 1, stepNames: ["past", "current", "next"] });
  state.steps[0]!.status = "done"; state.steps[1]!.status = "running";
  const scene = sceneOf(state);
  const lines = stripAnsi(constellationLinks(scene, 0, false, { geometry: "", paths: [] })).split("\n");
  const before = box(scene, "step:0"), current = box(scene, "step:1"), next = box(scene, "step:2");
  const y = current.y + 2;
  expect(lines[y]![Math.floor((before.x + before.width + current.x - 1) / 2)]).toBe("·");
  expect(lines[y]![Math.floor((current.x + current.width + next.x - 1) / 2)]).toBe("·");
  expect(lines.join("")).not.toContain("→");

  const nested = sceneOf(constellationFixture());
  const routed = stripAnsi(constellationLinks(nested, 2, true, { geometry: "", paths: [] }));
  expect(routed).not.toContain("→");
  expect(routed).toContain("─");
});

test("handoff slides the active root left, the next root inward, and both columns into place", () => {
  const state = constellationFixture(), transition = createConstellationTransition();
  const options = { animate: true, scope: state.steps };
  const before = transition.sample(sceneOf(state), 0, options);
  advance(state);
  const target = sceneOf(state);
  const start = transition.sample(target, 100, options);
  expect(box(start, "step:1").x).toBe(box(before, "step:1").x);
  expect(box(start, "step:2").x).toBe(box(before, "step:2").x);
  const middle = transition.sample(target, 100 + HANDOFF_DURATION_MS / 2, options);
  for (const id of ["step:1", "step:2"]) {
    expect(box(middle, id).x).toBeLessThan(box(before, id).x);
    expect(box(middle, id).x).toBeGreaterThan(box(target, id).x);
  }
  expect(box(middle, "step:0").y).toBeGreaterThan(box(before, "step:0").y);
  expect(box(middle, "step:3").y).toBeLessThan(box(before, "step:3").y);
  expect(box(middle, "step:1").prominence).toBeGreaterThan(0);
  expect(box(middle, "step:1").prominence).toBeLessThan(1);
  expect(transition.sample(target, 100 + HANDOFF_DURATION_MS, options)).toEqual(target);
  expect(transition.isTransitioning()).toBe(false);
});

test("rapid updates retarget from visible positions and summaries stay current during a handoff", () => {
  const state = constellationFixture(), transition = createConstellationTransition();
  const options = { animate: true, scope: state.steps };
  transition.sample(sceneOf(state), 0, options);
  advance(state);
  transition.sample(sceneOf(state), 100, options);
  const middle = transition.sample(sceneOf(state), 300, options);
  advance(state);
  const retarget = transition.sample(sceneOf(state), 300, options);
  expect(box(retarget, "step:2").x).toBe(box(middle, "step:2").x);
  expect(box(retarget, "step:2").y).toBe(box(middle, "step:2").y);
  state.steps[3]!.statusMessage = "Running integration tests";
  const updated = transition.sample(sceneOf(state), 600, options);
  expect(box(updated, "step:3").node.summary).toBe("Running integration tests");
  expect(transition.sample(sceneOf(state), 300 + HANDOFF_DURATION_MS, options)).toEqual(sceneOf(state));
});

test("reduced motion, resizing, and replacement iteration rows settle immediately", () => {
  for (const mode of ["reduced", "resize", "iteration"]) {
    const state = constellationFixture(), transition = createConstellationTransition();
    const options = { animate: true, scope: state.steps };
    transition.sample(sceneOf(state), 0, options);
    advance(state);
    transition.sample(sceneOf(state), 100, options);
    const target = sceneOf(state, mode === "resize" ? 70 : 139);
    const result = transition.sample(target, 200, { animate: mode !== "reduced", scope: mode === "iteration" ? [...state.steps] : state.steps });
    expect(result).toEqual(target);
    expect(transition.isTransitioning()).toBe(false);
  }
});

test("native bubbles move, remain clickable at their visible locations, and reach final slots", async () => {
  const state = constellationFixture();
  state.constellation!.reducedMotion = false;
  const setup = await createTestRenderer({ width: 140, height: 34 });
  const view = createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  try {
    await setup.flush();
    const outgoing = view.findDescendantById("bubble-step:1")!;
    const incoming = view.findDescendantById("bubble-step:2")!;
    const from = [outgoing.x, incoming.x];
    advance(state); notify();
    await Bun.sleep(220); await setup.flush();
    expect(outgoing.x).toBeGreaterThan(0);
    expect(outgoing.x).toBeLessThan(from[0]!);
    expect(incoming.x).toBeLessThan(from[1]!);
    await setup.mockMouse.click(outgoing.x + 3, outgoing.y + 1, 0, { delayMs: 0 });
    expect(state.selectedStepIndex).toBe(1);
    await Bun.sleep(HANDOFF_DURATION_MS); await setup.flush();
    expect(outgoing.x).toBe(box(sceneOf(state, setup.renderer.width - 2), "step:1").x);
    expect(incoming.x).toBe(box(sceneOf(state, setup.renderer.width - 2), "step:2").x);
    expect(setup.captureCharFrame()).not.toContain("→");
  } finally { setup.renderer.destroy(); }
});

test("the final handoff settles even when no running agents remain to animate", async () => {
  const state = createLoopState({ maxIterations: 1, stepNames: ["build"] });
  state.constellation = { detailsOpen: false, reducedMotion: false };
  state.steps[0]!.status = "running"; state.activeStepIndex = 0;
  const setup = await createTestRenderer({ width: 140, height: 22 });
  const view = createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  try {
    await setup.flush();
    advance(state); notify();
    await Bun.sleep(HANDOFF_DURATION_MS + 180); await setup.flush();
    expect(view.findDescendantById("bubble-step:0")!.x).toBe(0);
  } finally { setup.renderer.destroy(); }
});
