import { openAgentInspector, type InspectorTab } from "../src/lib/agent-inspector-state.ts";
import { mkdirSync } from "node:fs";
import { createTestRenderer } from "@opentui/core/testing";
import { constellationFixture } from "../test/fixtures/constellation-state.ts";
import { createConstellationView } from "../src/tui/constellation.ts";

const state = constellationFixture({ withInspection: true });
const width = Number(process.argv[2] ?? 140);
const height = Number(process.argv[3] ?? 34);
const mode = process.argv[4];
if (mode) {
  state.selectedBackgroundSessionID = "ses_tests";
  openAgentInspector(state, mode as InspectorTab);
}
const suffix = mode ? `-${mode}` : "";
const setup = await createTestRenderer({ width, height });
setup.renderer.root.add(createConstellationView(setup.renderer, state));
await setup.flush();
mkdirSync("test/.tmp/constellation", { recursive: true });
await Bun.write(`test/.tmp/constellation/frame-${width}${suffix}.txt`, setup.captureCharFrame());
const frame = setup.captureSpans();
await Bun.write(`test/.tmp/constellation/geometry-${width}${suffix}.json`, JSON.stringify(
  ["agent-inspector-dialog", "agent-inspector-header", "agent-inspector-title", "agent-inspector-close", "agent-inspector-metadata", "agent-inspector-tabs", "agent-inspector-output", "loop-agent-stream", "agent-inspector-text-pane", "agent-inspector-footer"].map((id) => {
    const r = setup.renderer.root.findDescendantById(id);
    return r ? { id, x: r.x, y: r.y, width: r.width, height: r.height } : { id };
  }), null, 2));
await Bun.write(`test/.tmp/constellation/frame-${width}${suffix}.json`, JSON.stringify({
  width, height, lines: frame.lines.map((line) => line.spans.map((span) => ({
    text: span.text, width: span.width, fg: span.fg.toInts(), bg: span.bg.toInts(), bold: Boolean(span.attributes & 1),
  }))),
}));
setup.renderer.destroy();
