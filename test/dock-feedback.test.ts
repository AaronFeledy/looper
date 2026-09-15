import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { cancelPendingNotify, createLoopState, notify } from "../src/lib/state.ts";
import { constellationDockPanels } from "../src/presentation/tui/constellation-dock.ts";
import { createDockFeedback, DOCK_PULSE_MS } from "../src/tui/dock-feedback.ts";
import { createConstellationView } from "../src/tui/constellation.ts";

afterEach(cancelPendingNotify);
function fixture() {
  const state = createLoopState({maxIterations: 1, stepNames: ["Build"]});
  state.constellation = {detailsOpen: false, reducedMotion: false};
  state.steps[0]!.status = "done";
  state.branchDiff = {kind: "ok", files: 0, additions: 0, deletions: 0};
  state.github = {kind: "no-pr"};
  state.prd = {kind: "ok", remaining: 0, total: 0};
  state.todos = [];
  return state;
}

test("panels distinguish empty, useful, completed and unavailable states", () => {
  const state = fixture();
  expect(constellationDockPanels(state).map(p => p.active)).toEqual([false, false, false, false]);
  state.branchDiff = {kind: "ok", files: 1, additions: 0, deletions: 0}; // rename/binary changes count too
  state.github = {kind: "error", message: "authentication required"};
  state.prd = {kind: "ok", remaining: 0, total: 4};
  state.todos = [{content: "Verify", status: "completed", priority: "high"}];
  const panels = constellationDockPanels(state);
  expect(panels.map(p => p.active)).toEqual([true, true, true, true]);
  expect(panels.map(p => p.tone)).toEqual(["activity", "attention", "success", "success"]);
  expect(panels[1]!.content).toBe("PR · unavailable");
});

test("each panel pulses twice for a new value, holds its active color, and dims silently when empty", () => {
  const state = fixture();
  for (const index of [0, 1, 2, 3]) {
    const feedback = createDockFeedback();
    const panel = constellationDockPanels(state)[index]!;
    const dim = feedback.sample(panel, 0, true);
    expect(feedback.isPulsing(0)).toBe(false);
    const active = {...panel, active: true, key: "new"};
    const steady = feedback.sample(active, 100, true);
    const firstPeak = feedback.sample({...active}, 500, true);
    expect(firstPeak.border).not.toBe(steady.border);
    expect(firstPeak.text).not.toBe(steady.text);
    expect(feedback.sample({...active}, 900, true)).toEqual(steady);
    expect(feedback.sample({...active}, 1300, true).border).not.toBe(steady.border);
    expect(feedback.sample({...active}, 100 + DOCK_PULSE_MS, true)).toEqual(steady);
    expect(feedback.isPulsing(2000)).toBe(false);
    // Same-value polling does not restart it.
    expect(feedback.sample({...active}, 3000, true)).toEqual(steady);
    expect(feedback.isPulsing(3000)).toBe(false);
    const changed = {...active, key: "changed"};
    feedback.sample(changed, 4000, true);
    expect(feedback.isPulsing(4000)).toBe(true);
    expect(feedback.sample(panel, 4100, true)).toEqual(dim);
    expect(feedback.isPulsing(4100)).toBe(false);
  }
});

test("semantic keys catch equal-count plan edits and PR review changes but ignore polling object identity", () => {
  const state = fixture();
  state.todos = [{content: "Write tests", status: "pending", priority: "high"}];
  state.github = {kind: "pr", pr: {
    number: 1, title: "Example", url: "https://example.com/pr/1", state: "OPEN", isDraft: false,
    mergeable: "mergeable", ciOverall: "passing", ciPending: 0, ciPassing: 3, ciFailing: 0, ciNeutral: 0, ciTotal: 3,
    bugbot: {state: "clean"},
  }};
  const before = constellationDockPanels(state);
  state.github = structuredClone(state.github);
  state.todos = structuredClone(state.todos);
  expect(constellationDockPanels(state)).toEqual(before);
  state.todos[0]!.content = "Write prefix tests";
  state.github.pr.bugbot = {state: "issues", unresolved: 2};
  const after = constellationDockPanels(state);
  expect(after[3]!.content).toBe(before[3]!.content);
  expect(after[3]!.key).not.toBe(before[3]!.key);
  expect(after[1]!.key).not.toBe(before[1]!.key);
  expect(after[1]!.tone).toBe("failure");
});

test("reduced motion keeps steady colors and cancels pending change pulses", () => {
  const state = fixture();
  state.branchDiff = {kind: "ok", files: 1, additions: 3, deletions: 0};
  const panel = constellationDockPanels(state)[0]!;
  const feedback = createDockFeedback();
  feedback.sample(panel, 0, true);
  const still = feedback.sample(panel, 300, false);
  expect(feedback.isPulsing(300)).toBe(false);
  expect(feedback.sample({...panel, key: "new"}, 400, false)).toEqual(still);
  expect(feedback.sample({...panel, key: "new"}, 800, true)).toEqual(still);
});

test("native dock pulses changes on a quiet stage and clearing the diff dims immediately", async () => {
  const state = fixture();
  const setup = await createTestRenderer({width: 140, height: 30});
  const view = createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  try {
    await setup.flush();
    const card = view.findDescendantById("constellation-context-0")!;
    const color = () => {
      let x = 0;
      for (const span of setup.captureSpans().lines[card.y]!.spans) {
        if (card.x + 2 < x + span.width) return span.fg.toInts();
        x += span.width;
      }
      throw new Error("missing border");
    };
    const dim = color();
    state.branchDiff = {kind: "ok", files: 2, additions: 8, deletions: 1};
    notify(); await Bun.sleep(80); await setup.flush();
    const active = color();
    expect(active).not.toEqual(dim);
    await Bun.sleep(320); await setup.flush();
    expect(color()).not.toEqual(active);
    state.branchDiff = {kind: "ok", files: 0, additions: 0, deletions: 0};
    notify(); await Bun.sleep(60); await setup.flush();
    expect(color()).toEqual(dim);
    await Bun.sleep(240); await setup.flush();
    expect(color()).toEqual(dim);
  } finally { setup.renderer.destroy(); }
});
