import { createCliRenderer } from "@opentui/core";
import { constellationFixture } from "../test/fixtures/constellation-state.ts";
import { createConstellationView } from "../src/tui/constellation.ts";
import { bindKeys } from "../src/tui/keys.ts";
import { createHelpOverlay } from "../src/tui/help-overlay.ts";
import { createPromptOverlay } from "../src/tui/prompt-overlay.ts";
import { createConfigOverlay } from "../src/tui/config-overlay.ts";
import { notify } from "../src/lib/state.ts";

const state = constellationFixture({ withInspection: true });
state.constellation!.reducedMotion = process.env.LOOPER_REDUCED_MOTION === "1";
const renderer = await createCliRenderer({ exitOnCtrlC: false });
renderer.root.add(createConstellationView(renderer, state));
renderer.root.add(createHelpOverlay(renderer, state));
renderer.root.add(createPromptOverlay(renderer, state));
renderer.root.add(createConfigOverlay(renderer, state, ".looper"));
const advance = () => {
  const current = state.steps[state.activeStepIndex ?? -1];
  if (!current) return;
  current.status = "done"; current.finishedAt = Date.now();
  current.backgroundAgents.forEach((agent) => { agent.activity = "idle"; agent.finishedAt = Date.now(); });
  const nextIndex = state.activeStepIndex! + 1;
  const next = state.steps[nextIndex];
  state.activeStepIndex = next ? nextIndex : null;
  if (next) {
    next.status = "running"; next.startedAt = Date.now();
    next.outputEvents = [{ kind: "assistant.text", text: `Starting ${next.name} with the previous agent's results.` }];
    if (!state.manualStepSelection) state.selectedStepIndex = nextIndex;
  }
  notify();
};
const quit = () => { unbind(); renderer.destroy(); process.exit(0); };
const unbind = bindKeys(renderer, state, {
  onEscape: quit, onInterrupt: quit, onQuit: quit, onRecoveryChoice() {},
  onRestart() {}, onSkip() {}, onStart: advance, onStopAfterIteration() {}, onTogglePause() {},
});
let tick = 0;
const timer = setInterval(() => {
  const agents = state.steps[1]!.backgroundAgents;
  const phrases = ["Writing the second component", "Checking component props", "Refining bubble spacing"];
  agents[0]!.activitySummary = { text: phrases[tick++ % phrases.length]!, observedAt: Date.now() };
  agents.forEach((agent) => { if (agent.activitySummary) agent.activitySummary.observedAt = Date.now(); });
  notify();
}, 3_000);
timer.unref();
