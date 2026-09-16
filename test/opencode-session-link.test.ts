import { afterEach, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { opencodeSessionUrl } from "../src/lib/opencode-session-link.ts";
import { createAgentInspector } from "../src/tui/agent-inspector.ts";
import { createAgentStream } from "../src/tui/agent-stream.ts";
import { openAgentInspector } from "../src/lib/agent-inspector-state.ts";
import { cancelPendingNotify, notify } from "../src/lib/state.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";
afterEach(cancelPendingNotify);

test("session links use the desktop scheme and accept only session identifiers", () => {
  expect(opencodeSessionUrl("ses_1051f4c46ffeLr7sGHm1xmXt3k")).toBe("opencode://ses_1051f4c46ffeLr7sGHm1xmXt3k");
  for (const id of [undefined, "", "https://example.com", "ses_bad/path", "ses_bad'argument", "ses_bad\nargument", "ses_bad?query"]) {
    expect(opencodeSessionUrl(id)).toBeUndefined();
  }
});

test("clicking Details opens the selected session, including a child; opener failure stays in the inspector", async () => {
  const state = constellationFixture({withInspection: true});
  openAgentInspector(state, "details");
  const setup = await createTestRenderer({width: 100, height: 32});
  const root = new BoxRenderable(setup.renderer, {width: "100%", height: "100%"});
  const opened: string[] = [];
  root.add(createAgentInspector(setup.renderer, state, createAgentStream(setup.renderer, state), root, {
    openSession: async id => { opened.push(id); if (id === "ses_tests") throw new Error("No handler"); },
  }));
  setup.renderer.root.add(root);
  try {
    await setup.flush();
    let row = root.findDescendantById("agent-inspector-session-link")!;
    expect(setup.captureCharFrame()).toContain("Session: ses_build");
    await setup.mockMouse.click(row.x + 10, row.y, 0, {delayMs: 0});
    await setup.flush();
    expect(opened).toEqual(["ses_build"]);
    expect(state.constellation?.detailsOpen).toBe(true);
    state.selectedBackgroundSessionID = "ses_tests"; notify();
    await Bun.sleep(40); await setup.flush();
    row = root.findDescendantById("agent-inspector-session-link")!;
    await setup.mockMouse.click(row.x + 10, row.y, 0, {delayMs: 0});
    await setup.flush();
    expect(opened).toEqual(["ses_build", "ses_tests"]);
    expect(setup.captureCharFrame()).toContain("Could not open OpenCode Desktop");
    expect(state.constellation?.detailsOpen).toBe(true);
  } finally { setup.renderer.destroy(); }
});
