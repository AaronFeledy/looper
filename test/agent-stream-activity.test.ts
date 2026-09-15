import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ScrollBoxRenderable } from "@opentui/core";
import { createAgentStream } from "../src/tui/agent-stream.ts";
import { createConstellationView } from "../src/tui/constellation.ts";
import { openAgentInspector } from "../src/lib/agent-inspector-state.ts";
import { cancelPendingNotify, notify } from "../src/lib/state.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";
afterEach(cancelPendingNotify);

for (const inspector of [false, true]) test(`${inspector ? "inspector" : "classic"} output has a fixed animated activity row just above its bottom border`, async () => {
  const state = constellationFixture({withInspection: true});
  state.constellation!.reducedMotion = false;
  if (inspector) openAgentInspector(state);
  else delete state.constellation;
  state.steps[1]!.outputPinnedToBottom = false;
  state.steps[1]!.outputScrollTop = 3;
  state.steps[1]!.outputEvents = [
    {kind: "assistant.text", text: Array.from({length: 50}, (_, i) => `Transcript line ${i}`).join("\n")},
    {kind: "tool.started", tool: "bash", input: {command: "bun run test:unit"}},
  ];
  const setup = await createTestRenderer({width: 100, height: 30});
  const view = inspector ? createConstellationView(setup.renderer, state) : createAgentStream(setup.renderer, state);
  setup.renderer.root.add(view);
  try {
    await setup.flush();
    const stream = (inspector ? view.findDescendantById("loop-agent-stream") : view) as ScrollBoxRenderable;
    const activity = view.findDescendantById("loop-agent-activity")!;
    const row = () => setup.captureSpans().lines[activity.y]!.spans.map(span => ({text: span.text, fg: span.fg.toInts()}));
    expect(activity.y).toBeGreaterThan(stream.y);
    expect(activity.y).toBe(stream.y + stream.height - 2);
    expect(activity.y).toBeGreaterThanOrEqual(stream.viewport.y + stream.viewport.height);
    expect(activity.x).toBeGreaterThan(stream.x);
    expect(activity.x + activity.width).toBeLessThan(stream.x + stream.width);
    expect(setup.captureCharFrame().split("\n")[activity.y]).toContain("Running unit tests");
    const before = row(), y = activity.y, content = stream.content.getChildren()[0];
    const scrollTop = stream.scrollTop;
    await Bun.sleep(200); await setup.flush();
    expect(row()).not.toEqual(before);
    expect(activity.y).toBe(y);
    expect(stream.scrollTop).toBe(scrollTop);
    expect(stream.content.getChildren()[0]).toBe(content);
    // Motion preference changes only the colors, not transcript geometry.
    state.constellation ??= {detailsOpen: false, reducedMotion: false};
    state.constellation.reducedMotion = true; notify();
    await Bun.sleep(40); await setup.flush();
    const still = row();
    await Bun.sleep(180); await setup.flush();
    expect(row()).toEqual(still);
  } finally { setup.renderer.destroy(); }
});

test("classic output summarizes the selected child's existing transcript and handles idle and permission states", async () => {
  const state = constellationFixture();
  delete state.constellation;
  state.selectedBackgroundSessionID = "ses_tests";
  const child = state.steps[1]!.backgroundAgents[1]!;
  child.activitySummary = undefined;
  child.outputEvents = [{kind: "tool.started", tool: "bash", input: {command: "bun run typecheck"}}];
  const setup = await createTestRenderer({width: 70, height: 20});
  const stream = createAgentStream(setup.renderer, state);
  setup.renderer.root.add(stream);
  const text = () => setup.captureCharFrame().split("\n")[stream.findDescendantById("loop-agent-activity")!.y]!;
  try {
    await setup.flush();
    expect(text()).toContain("Checking types");
    state.pendingRequests = [{kind: "permission", sessionID: child.sessionID, requestID: "ask", generation: 1, permission: "bash", patterns: [], status: "open"}];
    notify(); await Bun.sleep(40); await setup.flush();
    expect(text()).toContain("Waiting for approval");
    state.pendingRequests = []; child.activity = "idle";
    notify(); await Bun.sleep(40); await setup.flush();
    expect(text()).toContain("Session idle");
    state.selectedBackgroundSessionID = null;
    notify(); await Bun.sleep(40); await setup.flush();
    expect(text()).toContain("Editing constellation.ts");
    setup.resize(28, 16);
    await setup.flush();
    const activity = stream.findDescendantById("loop-agent-activity")!;
    expect(activity.y).toBe(stream.y + stream.height - 2);
    expect(activity.y).toBeGreaterThanOrEqual(stream.viewport.y + stream.viewport.height);
    expect(activity.x + activity.width).toBeLessThan(stream.x + stream.width);
  } finally { setup.renderer.destroy(); }
});


for (const inspector of [false, true]) test(`${inspector ? "inspector" : "classic"} activity row uses the configured PRD file roles`, async () => {
  const state = constellationFixture({ withInspection: true });
  state.activityContext = { repoDir: "/repo", prdDir: "spec/feature" };
  if (inspector) openAgentInspector(state);
  else delete state.constellation;
  state.steps[1]!.outputEvents = [{ kind: "tool.started", tool: "edit", input: { filePath: "/repo/spec/feature/prd.json" } }];
  const setup = await createTestRenderer({ width: 100, height: 30 });
  const view = inspector ? createConstellationView(setup.renderer, state) : createAgentStream(setup.renderer, state);
  setup.renderer.root.add(view);
  try {
    await setup.flush();
    const activity = view.findDescendantById("loop-agent-activity")!;
    expect(setup.captureCharFrame().split("\n")[activity.y]).toContain("Updating the PRD task list");
  } finally { setup.renderer.destroy(); }
});
