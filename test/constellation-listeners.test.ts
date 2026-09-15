import { afterEach, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { cancelPendingNotify, notify } from "../src/lib/state.ts";
import { openAgentInspector, closeAgentInspector } from "../src/lib/agent-inspector-state.ts";
import { createConstellationView } from "../src/tui/constellation.ts";
import { createHelpOverlay } from "../src/tui/help-overlay.ts";
import { createPromptOverlay } from "../src/tui/prompt-overlay.ts";
import { createDiagnosticsView } from "../src/tui/diagnostics.ts";
import { createConfigOverlay } from "../src/tui/config-overlay.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";

afterEach(cancelPendingNotify);

test("the complete constellation UI fits a finite listener budget and releases every selection listener", async () => {
  const setup = await createTestRenderer({width: 140, height: 34});
  const renderer = setup.renderer;
  renderer.setMaxListeners(10);
  const baseline = renderer.listenerCount("selection");
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => { warnings.push(warning); };
  process.on("warning", onWarning);
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const state = constellationFixture({withInspection: true});
      const root = new BoxRenderable(renderer, {id: `full-ui-${cycle}`, width: "100%", height: "100%"});
      root.add(createConstellationView(renderer, state));
      root.add(createDiagnosticsView(renderer, state));
      root.add(createHelpOverlay(renderer, state));
      root.add(createPromptOverlay(renderer, state));
      root.add(createConfigOverlay(renderer, state, "test/.tmp/no-config"));
      renderer.root.add(root);
      await setup.flush();
      const mountedCount = renderer.listenerCount("selection");
      expect(mountedCount - baseline).toBe(12);
      expect(renderer.getMaxListeners()).toBe(16);
      expect(mountedCount).toBeLessThanOrEqual(renderer.getMaxListeners());
      for (const modal of ["helpVisible", "promptModalVisible", "configModalVisible"] as const) {
        state[modal] = true; notify(); await Bun.sleep(40); await setup.flush();
        state[modal] = false; notify(); await Bun.sleep(40); await setup.flush();
        expect(renderer.listenerCount("selection")).toBe(mountedCount);
      }
      openAgentInspector(state); await Bun.sleep(40); await setup.flush();
      closeAgentInspector(state); await Bun.sleep(40); await setup.flush();
      expect(renderer.listenerCount("selection")).toBe(mountedCount);
      renderer.root.remove(root); root.destroyRecursively();
      expect(renderer.listenerCount("selection")).toBe(baseline);
    }
    await Bun.sleep(0);
    expect(warnings.filter(warning => warning.name === "MaxListenersExceededWarning")).toHaveLength(0);
  } finally {
    process.off("warning", onWarning);
    renderer.destroy();
  }
});

test("constellation preserves an explicitly larger or unlimited renderer listener allowance", async () => {
  for (const limit of [0, 32]) {
    const setup = await createTestRenderer({width: 140, height: 34});
    try {
      setup.renderer.setMaxListeners(limit);
      const view = createConstellationView(setup.renderer, constellationFixture());
      setup.renderer.root.add(view);
      expect(setup.renderer.getMaxListeners()).toBe(limit);
    } finally { setup.renderer.destroy(); }
  }
});
