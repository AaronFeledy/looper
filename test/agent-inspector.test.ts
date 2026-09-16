import { afterEach, expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { closeAgentInspector, openAgentInspector } from "../src/lib/agent-inspector-state.ts";
import { inspectorContext, inspectorDetails } from "../src/presentation/tui/agent-inspector.ts";
import { inspectSessionMessages } from "../src/lib/session-inspection.ts";
import { cancelPendingNotify, notify, resetIterationNavigationState, snapshotIterationToHistory } from "../src/lib/state.ts";
import { createConstellationView } from "../src/tui/constellation.ts";
import { bindKeys, type KeyHooks } from "../src/tui/keys.ts";
import { modalFocusWinner } from "../src/tui/permission-gate.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";
import { assistantMessage } from "./fixtures/session-messages.ts";

afterEach(cancelPendingNotify);
const hooks: KeyHooks = { onEscape() {}, onInterrupt() {}, onQuit() {}, onRecoveryChoice() {}, onRestart() {}, onSkip() {}, onStart() {}, onStopAfterIteration() {}, onTogglePause() {} };

async function mount(width = 140, height = 34) {
  const state = constellationFixture();
  const setup = await createTestRenderer({ width, height });
  const view = createConstellationView(setup.renderer, state);
  setup.renderer.root.add(view);
  const fired: string[] = [];
  const unbind = bindKeys(setup.renderer, state, { ...hooks, onEscape() { fired.push("escape"); }, onInterrupt() { fired.push("interrupt"); }, onStart() { fired.push("start"); } });
  const flush = async () => { await Bun.sleep(80); await setup.flush(); };
  await flush();
  return { ...setup, state, view, fired, flush, close() { unbind(); setup.renderer.destroy(); } };
}

test("single click selects; double click opens the correct child's modal without shifting the map", async () => {
  const ui = await mount();
  try {
    const child = ui.state.steps[1]!.backgroundAgents[1]!;
    child.inspection = inspectSessionMessages(child.sessionID, [assistantMessage(child.sessionID)]);
    child.outputLines = ["Child transcript, not the parent transcript."];
    child.outputEvents = [];
    const bubble = ui.view.findDescendantById("bubble-child:1:ses_tests")!;
    const sibling = ui.view.findDescendantById("bubble-child:1:ses_components")!;
    const before = [bubble.x, bubble.y, bubble.width, bubble.height];
    await ui.mockMouse.click(sibling.x + 2, sibling.y + 1);
    await ui.mockMouse.click(bubble.x + 2, bubble.y + 1);
    await ui.flush();
    expect(ui.state.selectedBackgroundSessionID).toBe("ses_tests");
    expect(ui.state.constellation?.detailsOpen).toBe(false);
    // Let the preceding selection click expire before the independent double-click gesture.
    await Bun.sleep(420);
    await ui.mockMouse.doubleClick(bubble.x + 2, bubble.y + 1);
    await ui.flush();
    expect(ui.state.constellation?.detailsOpen).toBe(true);
    expect(ui.captureCharFrame()).toContain("Child transcript, not the parent transcript.");
    expect(ui.captureCharFrame()).toContain("openai/reported-model");
    expect(ui.captureCharFrame()).toContain("Variant: low");
    expect([bubble.x, bubble.y, bubble.width, bubble.height]).toEqual(before);
    ui.mockInput.pressKey("ESCAPE"); await ui.flush();
    expect(ui.state.constellation?.detailsOpen).toBe(false);
    expect(ui.fired).toEqual([]);
    expect(ui.captureCharFrame()).toContain("Running unit tests");
  } finally { ui.close(); }
});

test("Enter inspects; tabs and scrolling retain the full prompt and details at narrow widths", async () => {
  const ui = await mount(80, 24);
  try {
    ui.state.steps[1]!.promptText = Array.from({ length: 45 }, (_, i) => `Full original instruction ${i + 1}`).join("\n");
    ui.mockInput.pressKey("RETURN"); await ui.flush();
    expect(ui.state.constellation?.detailsOpen).toBe(true);
    expect(ui.fired).toEqual([]);
    ui.mockInput.pressKey("TAB"); await ui.flush();
    expect(ui.state.constellation?.inspectorTab).toBe("details");
    expect(ui.captureCharFrame()).toContain("Session: ses_build");
    ui.mockInput.pressKey("3"); await ui.flush();
    expect(ui.captureCharFrame()).toContain("Full original instruction 1");
    ui.mockInput.pressKey("END"); await ui.flush();
    expect(ui.captureCharFrame()).toContain("Full original instruction 45");
    const bottom = ui.state.constellation!.inspectorScroll!;
    expect(bottom).toBeGreaterThan(0);
    ui.mockInput.pressArrow("up"); await ui.flush();
    expect(ui.state.constellation!.inspectorScroll).toBe(bottom - 1);
    ui.mockInput.pressKey("HOME"); await ui.flush();
    expect(ui.captureCharFrame()).toContain("Full original instruction 1");
    const close = ui.view.findDescendantById("agent-inspector-close")!;
    await ui.mockMouse.click(close.x + 1, close.y);
    await ui.flush();
    expect(ui.state.constellation?.detailsOpen).toBe(false);
  } finally { ui.close(); }
});

test("higher overlays and permissions own input, then return to the inspector", async () => {
  const ui = await mount();
  try {
    openAgentInspector(ui.state); await ui.flush();
    ui.mockInput.pressKey("c"); await ui.flush();
    expect(modalFocusWinner(ui.state)).toBe("config");
    ui.mockInput.pressKey("ESCAPE"); await ui.flush();
    expect(modalFocusWinner(ui.state)).toBe("inspector");
    expect(ui.fired).toEqual([]);
    ui.state.pendingRequests = [{ kind: "permission", sessionID: "ses_tests", requestID: "ask", generation: 1, permission: "bash", patterns: [], status: "open" }];
    notify(); await ui.flush();
    expect(ui.view.findDescendantById("agent-inspector-host")!.visible).toBe(false);
    ui.mockInput.pressKey("4");
    expect(ui.state.constellation?.inspectorTab).toBe("output");
    ui.state.pendingRequests = []; notify(); await ui.flush();
    expect(ui.view.findDescendantById("agent-inspector-host")!.visible).toBe(true);
    ui.mockInput.pressCtrlC(); await ui.flush();
    expect(ui.state.constellation?.detailsOpen).toBe(false);
    expect(ui.fired).toEqual([]);
  } finally { ui.close(); }
});

test("a hidden output tab retains manual scroll and shares its renderer with history", async () => {
  const ui = await mount(100, 26);
  try {
    const step = ui.state.steps[1]!;
    step.outputEvents = [];
    step.outputLines = Array.from({ length: 60 }, (_, i) => `Transcript line ${i}`);
    step.outputLineTimes = step.outputLines.map(() => 1);
    openAgentInspector(ui.state); await ui.flush();
    const stream = ui.view.findDescendantById("loop-agent-stream") as ScrollBoxRenderable;
    expect(stream).toBeInstanceOf(ScrollBoxRenderable);
    ui.mockInput.pressKey("HOME"); await ui.flush();
    expect(step.outputPinnedToBottom).toBe(false);
    ui.mockInput.pressKey("2"); await ui.flush();
    ui.mockInput.pressKey("1"); await ui.flush();
    expect(step.outputPinnedToBottom).toBe(false);
    expect(ui.captureCharFrame()).toContain("Transcript line 0");
    snapshotIterationToHistory(ui.state);
    ui.mockInput.pressKey("h"); await ui.flush();
    expect(ui.state.historyView).not.toBeNull();
    expect(ui.view.findDescendantById("loop-agent-stream")).toBe(stream);
    ui.mockInput.pressKey("h"); await ui.flush();
    openAgentInspector(ui.state); await ui.flush();
    expect(ui.view.findDescendantById("loop-agent-stream")).toBe(stream);
    resetIterationNavigationState(ui.state); notify(); await ui.flush();
    expect(ui.state.constellation?.detailsOpen).toBe(false);
  } finally { ui.close(); }
});

test("Context preserves detailed panel errors, complete todo text, PR status, and story gains", () => {
  const state = constellationFixture();
  state.branchDiff = { kind: "error", message: "Unable to compare base branch" };
  state.github = { kind: "pr", pr: {
    number: 42, title: "Full pull request title that the small capsule cannot show", url: "https://example.com/pr/42",
    state: "OPEN", isDraft: true, mergeable: "conflicting", ciOverall: "failing",
    ciPassing: 2, ciFailing: 1, ciPending: 3, ciNeutral: 4, ciTotal: 10, bugbot: { state: "issues", unresolved: 5 },
  } };
  state.prdIterationBaseline = 4;
  const context = inspectorContext(state);
  for (const text of ["Unable to compare base branch", state.github.pr.title, state.github.pr.url,
    "2 passing · 1 failing · 3 pending · 4 neutral / 10 total", "conflicting", "5 unresolved",
    "Complete gain this iteration: +2", "[pending] (medium) Document the feature flag"]) expect(context).toContain(text);
  state.steps[1]!.inspection = inspectSessionMessages("ses_build", [assistantMessage("ses_build")]);
  expect(inspectorDetails(state)).toContain("240 input · 80 output · 25 reasoning");
});

test("tool output expands inside the modal and stays expanded across tabs", async () => {
  const ui = await mount();
  try {
    const step = ui.state.steps[1]!;
    step.outputEvents = [
      { kind: "tool.started", tool: "bash", input: { command: "bun test" } },
      { kind: "tool.done", tool: "bash", output: Array.from({ length: 40 }, (_, i) => `test result ${i + 1}`).join("\n") },
    ];
    step.outputEventTimes = [1, 2];
    openAgentInspector(ui.state); await ui.flush();
    expect(ui.captureCharFrame()).toContain("click to expand");
    const expand = ui.view.findDescendantById("loop-agent-tool-0-expand")!;
    await ui.mockMouse.click(expand.x + 2, expand.y); await ui.flush();
    expect(ui.captureCharFrame()).toContain("test result 40");
    expect(ui.captureCharFrame()).toContain("click to hide full output");
    ui.mockInput.pressKey("2"); await ui.flush();
    ui.mockInput.pressKey("1"); await ui.flush();
    expect(ui.captureCharFrame()).toContain("click to hide full output");
  } finally { ui.close(); }
});

test("modal chrome stays within terminal cells and output never overlaps the footer on resize", async () => {
  const ui = await mount();
  try {
    openAgentInspector(ui.state); await ui.flush();
    for (const [width, height] of [[140, 34], [81, 25], [40, 24]]) {
      ui.resize(width!, height!); notify(); await ui.flush();
      const title = ui.view.findDescendantById("agent-inspector-title")!;
      const close = ui.view.findDescendantById("agent-inspector-close")!;
      const dialog = ui.view.findDescendantById("agent-inspector-dialog")!;
      const output = ui.view.findDescendantById("loop-agent-stream")!;
      const footer = ui.view.findDescendantById("agent-inspector-footer")!;
      expect(title.x + title.width).toBeLessThanOrEqual(close.x);
      expect(close.x + close.width).toBeLessThanOrEqual(dialog.x + dialog.width - 1);
      expect(output.y + output.height).toBeLessThanOrEqual(footer.y);
      expect(dialog.x + dialog.width).toBeLessThanOrEqual(width!);
    }
  } finally { ui.close(); }
});

test("long context values wrap before the overflow gutter in a 40-column terminal", async () => {
  const ui = await mount(40, 24);
  try {
    openAgentInspector(ui.state, "context"); await ui.flush();
    const pane = ui.view.findDescendantById("agent-inspector-text-pane")!;
    const content = ui.captureCharFrame().split("\n").slice(pane.y, pane.y + pane.height)
      .map((line) => line.slice(pane.x, pane.x + pane.width).replace(/[\s█▀▄│]/g, "")).join("");
    expect(content).toContain("Branch:" + ui.state.branch);
  } finally { ui.close(); }
});
