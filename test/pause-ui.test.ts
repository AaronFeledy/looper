import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, test } from "bun:test";

import {
  createLoopState,
  flattenRows,
  selectNextStep,
  selectPreviousStep,
  selectStepListRow,
  syncStepBackgroundAgents,
} from "../src/lib/state.ts";
import { createFooter, footerStatus, footerStatusDivider } from "../src/tui/footer.ts";
import { isPauseEngaged, pauseRowAppearance } from "../src/tui/step-list.ts";

function state(stepNames: string[]) {
  return createLoopState({ maxIterations: 1, stepNames });
}

describe("isPauseEngaged", () => {
  test("is false while a step is still running", () => {
    const s = state(["build"]);
    const build = s.steps[0];
    if (build === undefined) throw new Error("expected a step");
    build.status = "running";
    s.paused = true;
    expect(isPauseEngaged(s)).toBe(false);
  });

  test("is true once no step is live", () => {
    const s = state(["build", "review"]);
    const build = s.steps[0];
    if (build === undefined) throw new Error("expected a step");
    build.status = "done";
    s.paused = true;
    expect(isPauseEngaged(s)).toBe(true);
  });

  test("is false when not paused", () => {
    const s = state(["build"]);
    expect(isPauseEngaged(s)).toBe(false);
  });
});

describe("footerStatus pause flag", () => {
  test("hides paused until the current live step finishes", () => {
    const s = state(["build"]);
    s.started = true;
    const build = s.steps[0];
    if (build === undefined) throw new Error("expected a step");
    build.status = "running";
    s.paused = true;
    expect(footerStatus(s)).not.toContain("paused");
    build.status = "done";
    expect(footerStatus(s)).toContain("paused");
  });

  test("still shows other run flags while a pause is only pending", () => {
    const s = state(["build"]);
    s.started = true;
    const build = s.steps[0];
    if (build === undefined) throw new Error("expected a step");
    build.status = "running";
    s.paused = true;
    s.stopAfterIteration = true;
    const text = footerStatus(s);
    expect(text).not.toContain("paused");
    expect(text).toContain("ending after iteration");
  });
});

describe("footerStatusDivider", () => {
  test("is empty when there is no status message", () => {
    const s = state(["build"]);
    expect(footerStatus(s)).toBe("");
    expect(footerStatusDivider(s)).toBe("");
  });

  test("is a mid-dot when a status message is present", () => {
    const s = state(["build"]);
    s.paused = true;
    expect(footerStatus(s).length).toBeGreaterThan(0);
    expect(footerStatusDivider(s)).toBe("·");
  });
});

describe("flattenRows pause marker", () => {
  test("inserts Pause after the last non-pending step", () => {
    const s = state(["build", "review", "check"]);
    const build = s.steps[0];
    if (build === undefined) throw new Error("expected build step");
    build.status = "running";
    s.paused = true;

    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      { kind: "pause" },
      { kind: "step", stepIndex: 1 },
      { kind: "step", stepIndex: 2 },
    ]);
  });

  test("places Pause after a live step's background rows", () => {
    const s = state(["build", "review"]);
    const build = s.steps[0];
    if (build === undefined) throw new Error("expected build step");
    build.status = "running";
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1 }]);
    s.paused = true;

    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      { kind: "background", stepIndex: 0, sessionID: "ses_a" },
      { kind: "pause" },
      { kind: "step", stepIndex: 1 },
    ]);
  });

  test("places Pause first when every step is still pending", () => {
    const s = state(["build", "review"]);
    s.paused = true;
    expect(flattenRows(s)).toEqual([
      { kind: "pause" },
      { kind: "step", stepIndex: 0 },
      { kind: "step", stepIndex: 1 },
    ]);
  });

  test("omits Pause when not paused", () => {
    const s = state(["build"]);
    expect(flattenRows(s).some((row) => row.kind === "pause")).toBe(false);
  });
});

describe("pause row selection", () => {
  test("up/down skip the Pause marker", () => {
    const s = state(["build", "review"]);
    const build = s.steps[0];
    if (build === undefined) throw new Error("expected build step");
    build.status = "running";
    s.paused = true;
    s.selectedStepIndex = 0;
    s.manualStepSelection = true;

    expect(selectNextStep(s)).toEqual({ kind: "step", stepIndex: 1 });
    expect(selectPreviousStep(s)).toEqual({ kind: "step", stepIndex: 0 });
  });

  test("clicking Pause does not change the selected step", () => {
    const s = state(["build", "review"]);
    const build = s.steps[0];
    if (build === undefined) throw new Error("expected build step");
    build.status = "running";
    s.paused = true;
    s.selectedStepIndex = 0;
    s.manualStepSelection = true;

    selectStepListRow(s, 1);
    expect(s.selectedStepIndex).toBe(0);
  });
});

describe("pauseRowAppearance", () => {
  test("is muted while waiting for the current step, bold yellow when engaged", () => {
    const s = state(["build"]);
    const build = s.steps[0];
    if (build === undefined) throw new Error("expected a step");
    build.status = "running";
    s.paused = true;
    const pending = pauseRowAppearance(s);
    expect(pending.content).toContain("Pause");
    expect(pending.bold).toBe(false);

    build.status = "done";
    const engaged = pauseRowAppearance(s);
    expect(engaged.content).toContain("Pause");
    expect(engaged.bold).toBe(true);
    expect(engaged.fg).toBe("#f9e2af");
  });
});

describe("footer branch/status divider", () => {
  test("renders a mid-dot between the branch and a status message", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 72, height: 3 });
    const s = state(["build"]);
    s.branch = "feat/x";
    s.paused = true;
    renderer.root.add(createFooter(renderer, s));
    await renderOnce();
    const frame = captureCharFrame();
    renderer.destroy();
    const line = frame.split("\n").find((candidate) => candidate.includes("Branch:"));
    expect(line).toBeDefined();
    if (line === undefined) return;
    const branchAt = line.indexOf("Branch: feat/x");
    const dividerAt = line.indexOf("·");
    const statusAt = line.indexOf("paused");
    expect(branchAt).toBeGreaterThanOrEqual(0);
    expect(dividerAt).toBeGreaterThan(branchAt);
    expect(statusAt).toBeGreaterThan(dividerAt);
  });
});
