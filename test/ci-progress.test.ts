import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createLoopState, cancelPendingNotify, notify } from "../src/lib/state.ts";
import { createConstellationView } from "../src/tui/constellation.ts";
import { createGithubStatusPanel } from "../src/tui/github-status.ts";
import { DOCK_PULSE_MS } from "../src/tui/dock-feedback.ts";
import { ciBorderColor, ciCounts, ciIsRunning } from "../src/tui/ci-progress.ts";

afterEach(cancelPendingNotify);
function fixture() {
  const state = createLoopState({maxIterations: 1, stepNames: ["Build"]});
  state.started = true;
  state.steps[0]!.status = "done"; // CI must animate even on a quiet stage.
  state.constellation = {detailsOpen: false, reducedMotion: false};
  state.branchDiff = {kind: "ok", files: 8, additions: 248, deletions: 36};
  state.github = {kind: "pr", pr: {
    number: 924, title: "Verify the change", url: "https://example.com/pr/924",
    state: "OPEN", isDraft: false, mergeable: "mergeable", ciOverall: "failing",
    ciPassing: 3, ciFailing: 1, ciPending: 2, ciNeutral: 1, ciTotal: 7,
  }};
  return state;
}

test("CI progress includes unfinished checks even after another check fails", () => {
  const status = fixture().github;
  expect(ciIsRunning(status)).toBe(true);
  if (status.kind !== "pr") throw new Error("missing PR");
  expect(ciCounts(status.pr)).toBe("◷2 ✓3 ✗1 ~1");
  status.pr.ciPending = 0;
  expect(ciIsRunning(status)).toBe(false);
  expect(ciBorderColor(0, false)).not.toBe(ciBorderColor(700, false));
  expect(ciBorderColor(0, true)).toBe(ciBorderColor(700, true));
});

for (const classic of [false, true]) test(`${classic ? "classic" : "constellation"} PR border pulses until CI settles and obeys reduced motion`, async () => {
  const state = fixture();
  const setup = await createTestRenderer({width: 140, height: 30});
  const view = classic ? createGithubStatusPanel(setup.renderer, state) : createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  try {
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("◷2 ✓3 ✗1 ~1");
    if (!classic) expect(setup.captureCharFrame()).toContain("8 files");
    const card = classic ? view : view.findDescendantById("constellation-context-1")!;
    const color = () => {
      const target = card.x + card.width - 2;
      let x = 0;
      for (const span of setup.captureSpans().lines[card.y]!.spans) {
        if (target < x + span.width) return span.fg.toInts();
        x += span.width;
      }
      throw new Error("border not rendered");
    };
    const initial = color();
    await Bun.sleep(200); await setup.flush(); const next = color();
    await Bun.sleep(200); await setup.flush(); const last = color();
    expect(JSON.stringify(initial) !== JSON.stringify(next) || JSON.stringify(next) !== JSON.stringify(last)).toBe(true);
    state.constellation!.reducedMotion = true; notify();
    await Bun.sleep(50); await setup.flush(); const still = color();
    await Bun.sleep(220); await setup.flush(); expect(color()).toEqual(still);
    if (state.github.kind !== "pr") throw new Error("missing PR");
    state.github.pr.ciPending = 0;
    state.github.pr.ciOverall = "failing";
    state.constellation!.reducedMotion = false; notify();
    await Bun.sleep(classic ? 50 : DOCK_PULSE_MS + 100); await setup.flush(); const stopped = color();
    await Bun.sleep(220); await setup.flush(); expect(color()).toEqual(stopped);
  } finally { setup.renderer.destroy(); }
});
