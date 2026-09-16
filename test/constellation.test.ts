import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { compactActivity, summarizeActivity, toolActivity } from "../src/core/agent-activity.ts";
import { constellationEnabled } from "../src/config/tunables.ts";
import { constellationAgents, layoutConstellation, visibleConstellationAgents } from "../src/presentation/tui/constellation.ts";
import { cancelPendingNotify, createBackgroundAgent, finalizeStepRow, notify, snapshotIterationToHistory } from "../src/lib/state.ts";
import { syncStepAgentTree } from "../src/lib/agent-tree-state.ts";
import { createConstellationView } from "../src/tui/constellation.ts";
import { bindKeys, type KeyHooks } from "../src/tui/keys.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";

afterEach(cancelPendingNotify);
const hooks: KeyHooks = { onEscape() {}, onInterrupt() {}, onQuit() {}, onRecoveryChoice() {}, onRestart() {}, onSkip() {}, onStart() {}, onStopAfterIteration() {}, onTogglePause() {} };

describe("agent activity", () => {
  test("recognizes tools and never exposes output or reasoning text", () => {
    expect(toolActivity("bash", { command: "bun run test:unit" })).toBe("Running unit tests");
    expect(toolActivity("bash", { command: "bun run typecheck" })).toBe("Checking types");
    expect(toolActivity("edit", { filePath: "/repo/src/Button.tsx" })).toBe("Editing Button.tsx");
    expect(summarizeActivity([{ kind: "reasoning.text", text: "private raw reasoning" }])).toBe("Thinking through the next move");
    expect(summarizeActivity([{ kind: "tool.done", tool: "bash", output: "arbitrarily large output" }])).toBe("Reviewing tool results");
    expect(compactActivity("one two three four five six seven eight nine")).toBe("one two three four five six seven…");
  });
  test("ignores turn completion, user text, and diagnostic overlays after real activity", () => {
    expect(summarizeActivity([
      { kind: "tool.started", tool: "bash", input: { command: "bun test" } },
      { kind: "user.text", text: "Say something else" },
      { kind: "looper.log", message: "timeout in 5m" },
      { kind: "step.done", reason: "stop", cost: 0, tokens: {input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0} },
    ])).toBe("Running tests");
    expect(summarizeActivity([{ kind: "assistant.text", text: "Running unit tests before moving on." }])).toBe("Running unit tests before moving on");
  });
  test("is explicitly opt-in", () => {
    for (const value of ["", "classic", "true", "1", "typo"]) expect(constellationEnabled(value)).toBe(false);
    expect(constellationEnabled("constellation")).toBe(true);
  });
});

describe("constellation layout and lifecycle", () => {
  test("shows simultaneous summaries and real parent links, including grandchildren", () => {
    const nodes = constellationAgents(constellationFixture());
    expect(nodes.filter((node) => node.lane === "live" && node.status !== "idle")).toHaveLength(5);
    expect(nodes.find((node) => node.name === "Verify the activity feed")?.summary).toBe("Running unit tests");
    expect(nodes.find((node) => node.name === "Audit keyboard navigation")?.parentID).toBe("child:1:ses_components");

    // Retired siblings do not force a waiting parent and its lone child apart.
    const state = constellationFixture();
    state.steps[1]!.status = "waiting";
    state.steps[1]!.backgroundAgents.forEach((agent, i) => { agent.activity = i === 0 ? "busy" : "idle"; });
    for (const width of [32, 80, 106, 140, 240]) {
      const scene = layoutConstellation(constellationAgents(state), width);
      const parent = scene.bubbles.find((bubble) => bubble.node.id === "step:1")!;
      const child = scene.bubbles.find((bubble) => bubble.node.id === "child:1:ses_components")!;
      expect(Math.abs(child.x + child.width / 2 - parent.x - parent.width / 2)).toBeLessThanOrEqual(0.5);
      expect(child.width).toBeLessThanOrEqual(parent.width);
      expect(child.y).toBeGreaterThan(parent.y + parent.height);
      expect(Math.abs(parent.x + parent.width / 2 - width / 2)).toBeLessThanOrEqual(0.5);
    }
  });
  test("fits every bubble without overlaps, including narrow terminals and large swarms", () => {
    const state = constellationFixture();
    for (let i = 0; i < 30; i++) state.steps[1]!.backgroundAgents.push(createBackgroundAgent(`ses_extra${i}`, i, { activity: "busy", parentSessionID: "ses_build" }));
    const nodes = constellationAgents(state);
    for (const width of [16, 32, 60, 80, 106, 140, 240]) {
      const scene = layoutConstellation(nodes, width);
      expect(scene.bubbles).toHaveLength(visibleConstellationAgents(nodes).length);
      for (const a of scene.bubbles) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.x + a.width).toBeLessThanOrEqual(width);
        expect(a.y + a.height).toBeLessThanOrEqual(scene.height);
        for (const b of scene.bubbles) {
          if (a === b) continue;
          expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
        }
      }
    }
  });
  test("retains retired children only in the experimental UI", () => {
    const state = constellationFixture();
    finalizeStepRow(state, 1, "done");
    syncStepAgentTree(state, 1, []);
    expect(state.steps[1]!.backgroundAgents).toHaveLength(5);
    expect(state.steps[1]!.backgroundAgents.every((agent) => agent.activity === "idle")).toBe(true);
    delete state.constellation;
    finalizeStepRow(state, 1, "done");
    expect(state.steps[1]!.backgroundAgents).toHaveLength(0);
  });
  test("marks stale summaries and attaches requests to their actual owner", () => {
    const state = constellationFixture();
    state.steps[1]!.backgroundAgents[0]!.activitySummary!.observedAt = 1;
    state.pendingRequests = [{ kind: "permission", sessionID: "ses_tests", requestID: "ask", generation: 1, permission: "bash", patterns: [], status: "open" }];
    const nodes = constellationAgents(state);
    expect(nodes.find((node) => node.name === "Build the activity bubbles")?.summary).toStartWith("Last:");
    expect(nodes.find((node) => node.name === "Verify the activity feed")?.summary).toBe("Waiting for approval");
    expect(nodes.find((node) => node.name === "implement")?.badge).toBe("1/4 todos");
  });
});

test("real renderer exposes all five live summaries and keyboard transcript inspection", async () => {
  const state = constellationFixture();
  const setup = await createTestRenderer({ width: 140, height: 34 });
  const view = createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  const unbind = bindKeys(setup.renderer, state, hooks);
  try {
    await setup.flush();
    const frame = setup.captureCharFrame();
    for (const text of ["WORKING NOW", "Writing the second component", "Running unit tests", "Checking keyboard navigation", "Writing the usage guide", "TRAIL", "UP NEXT"]) expect(frame).toContain(text);
    setup.mockInput.pressKey("o");
    await Bun.sleep(50); await setup.flush();
    expect(state.constellation?.detailsOpen).toBe(true);
    expect(setup.captureCharFrame()).toContain("Building the agent constellation.");
    setup.mockInput.pressKey("o");
    setup.mockInput.pressArrow("down");
    await Bun.sleep(50); await setup.flush();
    expect(state.selectedBackgroundSessionID).toBe("ses_components");
    setup.mockInput.pressKey("m");
    expect(state.constellation?.reducedMotion).toBe(false);
    setup.resize(70, 30);
    notify(); await Bun.sleep(50); await setup.flush();
    expect(setup.captureCharFrame()).toContain("Running unit tests");
  } finally { unbind(); setup.renderer.destroy(); }
});

test("work-plan scrolling and history remain reachable from the constellation", async () => {
  const state = constellationFixture();
  snapshotIterationToHistory(state);
  const setup = await createTestRenderer({ width: 140, height: 34 });
  setup.renderer.root.add(createConstellationView(setup.renderer, state));
  const unbind = bindKeys(setup.renderer, state, hooks);
  try {
    setup.mockInput.pressKey("i");
    await Bun.sleep(40); await setup.flush();
    expect(setup.captureCharFrame()).toContain("Build bubbles");
    setup.mockInput.pressArrow("down");
    expect(state.constellation?.planScroll).toBe(1);
    setup.mockInput.pressKey("i");
    setup.mockInput.pressKey("h");
    await Bun.sleep(40); await setup.flush();
    expect(setup.captureCharFrame()).toContain("History");
    setup.mockInput.pressKey("h");
    await Bun.sleep(40); await setup.flush();
    expect(setup.captureCharFrame()).toContain("WORKING NOW");
  } finally { unbind(); setup.renderer.destroy(); }
});

test("permission requests keep ownership of input over experimental shortcuts", async () => {
  const state = constellationFixture();
  state.pendingRequests = [{ kind: "permission", sessionID: "ses_tests", requestID: "ask", generation: 1, permission: "bash", patterns: [], status: "open" }];
  const setup = await createTestRenderer({ width: 140, height: 34 });
  setup.renderer.root.add(createConstellationView(setup.renderer, state));
  const unbind = bindKeys(setup.renderer, state, hooks);
  try {
    setup.mockInput.pressKey("o"); setup.mockInput.pressKey("i"); setup.mockInput.pressKey("m");
    expect(state.constellation).toEqual({ detailsOpen: false, reducedMotion: true });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Waiting for approval");
    expect(setup.captureCharFrame()).toContain("needs you");
  } finally { unbind(); setup.renderer.destroy(); }
});
