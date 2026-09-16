import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ScrollBoxRenderable } from "@opentui/core";
import { cancelPendingNotify, createLoopState, createStepRow, insertRestartAttempt, notify } from "../src/lib/state.ts";
import { constellationAgents, constellationNextIteration, layoutConstellation, moveConstellationSelection } from "../src/presentation/tui/constellation.ts";
import { createConstellationTransition, HANDOFF_DURATION_MS } from "../src/presentation/tui/constellation-transition.ts";
import { routeConstellationLinks } from "../src/presentation/tui/constellation-routing.ts";
import { createConstellationView } from "../src/tui/constellation.ts";

afterEach(cancelPendingNotify);
function fixture() {
  const state = createLoopState({ maxIterations: 3, stepNames: ["Plan", "Build", "Review", "Verify"] });
  state.constellation = { detailsOpen: false, reducedMotion: true };
  state.started = true; state.iteration = 1;
  state.steps[0]!.status = "done"; state.steps[1]!.status = "running";
  state.activeStepIndex = 1; state.selectedStepIndex = 1;
  return state;
}
const sceneOf = (state: ReturnType<typeof fixture>, width = 138) =>
  layoutConstellation(constellationAgents(state), width, constellationNextIteration(state));

test("lookahead uses configured steps, preserves duplicate names, and honors iteration limits", () => {
  const state = createLoopState({ maxIterations: 3, stepNames: ["Review", "Review", "Publish"] });
  expect(constellationNextIteration(state)).toEqual({ iteration: 2, stepNames: ["Review", "Review", "Publish"] });
  state.iteration = 1;
  insertRestartAttempt(state, 0, "timeout");
  state.steps.push(createStepRow("Adjudicate"));
  expect(constellationNextIteration(state)!.stepNames).toEqual(["Review", "Review", "Publish"]);
  state.stopAfterIteration = true; expect(constellationNextIteration(state)).toBeUndefined();
  state.stopAfterIteration = false; state.iteration = 2;
  expect(constellationNextIteration(state)!.iteration).toBe(3);
  state.iteration = 3; expect(constellationNextIteration(state)).toBeUndefined();
  state.iteration = 1; state.quitting = true; expect(constellationNextIteration(state)).toBeUndefined();
});

test("a non-agent marker separates this queue from exactly one future iteration at every width", () => {
  const state = fixture();
  for (const width of [16, 32, 80, 106, 138, 240]) {
    const scene = sceneOf(state, width), marker = scene.loopMarker!;
    const current = scene.bubbles.filter(item => item.node.lane === "next" && !item.node.previewIteration);
    const previews = scene.bubbles.filter(item => item.node.previewIteration);
    expect(previews.map(item => item.node.name)).toEqual([...state.configuredStepNames]);
    expect(marker.y).toBeGreaterThanOrEqual(Math.max(...current.map(item => item.y + item.height)));
    expect(previews[0]!.y).toBeGreaterThanOrEqual(marker.y + marker.height);
    expect(new Set(scene.bubbles.map(item => item.node.id)).size).toBe(scene.bubbles.length);
    for (const item of [...scene.bubbles, marker]) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x + item.width).toBeLessThanOrEqual(width);
      expect(item.y + item.height).toBeLessThanOrEqual(scene.height);
    }
    if (scene.regions) {
      expect(marker.region).toBe("nextTail");
      expect(scene.regions.nextTail.height + scene.regions.nextTail.y).toBeGreaterThan(previews.at(-1)!.y);
    }
    const paths = routeConstellationLinks(scene, { geometry: "", paths: [] });
    // No path connects a preview to the current pass across the divider.
    for (const path of paths) expect(path.points.some(point =>
      point.x >= marker.x && point.x < marker.x + marker.width &&
      point.y >= marker.y && point.y < marker.y + marker.height)).toBe(false);
  }
  state.steps.forEach((step, i) => { step.status = i === 3 ? "running" : "done"; });
  const end = sceneOf(state);
  expect(end.loopMarker!.region).toBe("nextHead");
  expect(end.loopMarker!.y).toBe(2);
  expect(end.bubbles.filter(item => item.node.previewIteration).every(item => item.region === "nextTail")).toBe(true);
});

test("the divider slides upward with the queue and stops repeating after the final pass", () => {
  const state = fixture(), transition = createConstellationTransition();
  const options = { animate: true, scope: state.steps };
  const before = sceneOf(state); transition.sample(before, 0, options);
  state.steps[1]!.status = "done"; state.steps[2]!.status = "running";
  const target = sceneOf(state); transition.sample(target, 100, options);
  const middle = transition.sample(target, 100 + HANDOFF_DURATION_MS / 2, options);
  expect(middle.loopMarker!.y).toBeGreaterThan(target.loopMarker!.y);
  expect(middle.loopMarker!.y).toBeLessThan(before.loopMarker!.y);
  expect(transition.sample(target, 100 + HANDOFF_DURATION_MS, options)).toEqual(target);
  state.iteration = 3;
  expect(sceneOf(state).loopMarker).toBeUndefined();
  expect(sceneOf(state).bubbles.some(item => item.node.previewIteration)).toBe(false);
});

test("the preview scrolls below the pinned queue, never selects old output, and refreshes on rollover", async () => {
  const state = fixture();
  const setup = await createTestRenderer({ width: 140, height: 30 });
  const view = createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  const flush = async () => { await Bun.sleep(60); await setup.flush(); };
  try {
    await setup.flush();
    const queue = view.findDescendantById("constellation-scroll-nextTail") as ScrollBoxRenderable;
    const head = view.findDescendantById("bubble-step:2")!;
    const marker = view.findDescendantById("constellation-loop-marker")!;
    const headY = head.y, markerY = marker.y;
    await setup.mockMouse.scroll(queue.x + 3, queue.y + 3, "down", { delayMs: 0 });
    notify(); await flush();
    expect(queue.scrollTop).toBeGreaterThan(0);
    expect(marker.y).toBeLessThan(markerY);
    expect(head.y).toBe(headY);
    const preview = view.findDescendantById("bubble-preview:2:0")!;
    await setup.mockMouse.doubleClick(preview.x + 3, preview.y + 1, 0, { delayMs: 0 }); await flush();
    expect(state.selectedStepIndex).toBe(1);
    expect(state.constellation!.detailsOpen).toBe(false);
    for (let i = 0; i < 12; i++) {
      moveConstellationSelection(state, 1);
      expect(state.selectedStepIndex).toBeLessThan(state.steps.length);
    }
    state.iteration = 2;
    state.steps = state.configuredStepNames.map(name => createStepRow(name));
    state.steps[0]!.status = "running"; state.activeStepIndex = 0; state.selectedStepIndex = 0;
    notify(); await flush();
    expect(queue.scrollTop).toBe(0);
    expect(view.findDescendantById("bubble-preview:2:0")).toBeUndefined();
    expect(view.findDescendantById("bubble-preview:3:0")).toBeDefined();
    state.stopAfterIteration = true; notify(); await flush();
    expect(marker.visible).toBe(false);
    expect(view.findDescendantById("bubble-preview:3:0")).toBeUndefined();
  } finally { setup.renderer.destroy(); }
});
