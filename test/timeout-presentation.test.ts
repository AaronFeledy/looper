import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { cancelPendingNotify, createLoopState, enterHistoryView, insertRestartAttempt, notify, snapshotIterationToHistory } from "../src/lib/state.ts";
import { constellationAgents } from "../src/presentation/tui/constellation.ts";
import { stepActivitySummary } from "../src/presentation/tui/agent-activity.ts";
import { inspectorDetails } from "../src/presentation/tui/agent-inspector.ts";
import { createConstellationView } from "../src/tui/constellation.ts";
import { createStepList } from "../src/tui/step-list.ts";
import { createAgentStream } from "../src/tui/agent-stream.ts";

afterEach(cancelPendingNotify);
function timedOutAttempt() {
  const state = createLoopState({ maxIterations: 2, stepNames: ["Build"] });
  state.started = true; state.iteration = 1;
  state.constellation = { detailsOpen: false, reducedMotion: true };
  state.steps[0]!.status = "running";
  state.steps[0]!.sessionID = "ses_timeout";
  state.steps[0]!.startedAt = Date.now() - 60_000;
  state.steps[0]!.outputLines = ["Partial work before timeout"];
  const retry = insertRestartAttempt(state, 0, "timeout");
  state.steps[retry]!.status = "running";
  state.activeStepIndex = retry; state.selectedStepIndex = 0;
  return state;
}

test("a retired timeout is labeled as a timeout while its retry runs separately", () => {
  const state = timedOutAttempt();
  const [old, retry] = constellationAgents(state);
  expect(old!.lane).toBe("past");
  expect(old!.restartReason).toBe("timeout");
  expect(old!.summary).toBe("Timed out");
  expect(retry!.lane).toBe("live");
  expect(retry!.restartReason).toBeUndefined();
  expect(inspectorDetails(state)).toContain("Status: Timed out");
  // Stale activity text cannot turn a timeout back into a success message.
  state.steps[0]!.statusMessage = "Work complete";
  expect(stepActivitySummary(state.steps[0]!)).toBe("Timed out");
  expect(stepActivitySummary({ ...state.steps[0]!, restartReason: "manual" })).toBe("Restarted");
  expect(stepActivitySummary({ ...state.steps[0]!, restartReason: undefined, statusMessage: undefined })).toBe("Work complete");
});

for (const classic of [false, true]) test(`${classic ? "classic and history" : "constellation"} shows a failure mark and timeout text`, async () => {
  const state = timedOutAttempt();
  const setup = await createTestRenderer({width: 140, height: 28});
  const view = classic ? createStepList(setup.renderer, state) : createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  try {
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("✗ Build");
    expect(setup.captureCharFrame()).toContain("Timed out");
    expect(setup.captureCharFrame()).not.toContain("Work complete");
    expect(setup.captureCharFrame()).not.toContain("✓ Build");
    if (classic) {
      snapshotIterationToHistory(state);
      enterHistoryView(state); notify();
      await Bun.sleep(50); await setup.flush();
      expect(setup.captureCharFrame()).toContain("✗ Build");
      expect(setup.captureCharFrame()).toContain("Timed out");
    }
  } finally { setup.renderer.destroy(); }
});

test("current and historical full output keep the timeout summary", async () => {
  const state = timedOutAttempt();
  const setup = await createTestRenderer({width: 80, height: 20});
  const stream = createAgentStream(setup.renderer, state);
  setup.renderer.root.add(stream);
  try {
    await setup.flush();
    const summary = () => setup.captureCharFrame().split("\n")[stream.findDescendantById("loop-agent-activity")!.y]!;
    expect(summary()).toContain("Timed out");
    snapshotIterationToHistory(state); enterHistoryView(state); notify();
    await Bun.sleep(50); await setup.flush();
    expect(summary()).toContain("Timed out");
  } finally { setup.renderer.destroy(); }
});
