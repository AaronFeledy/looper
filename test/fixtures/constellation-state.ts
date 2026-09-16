import { inspectSessionMessages } from "../../src/lib/session-inspection.ts";
import { assistantMessage } from "./session-messages.ts";
import { createBackgroundAgent, createLoopState } from "../../src/lib/state.ts";

export function constellationFixture({ withInspection = false } = {}) {
  const now = Date.now();
  const state = createLoopState({ maxIterations: 20, stepNames: ["plan", "implement", "review", "verify", "publish"] });
  state.constellation = { detailsOpen: false, reducedMotion: true };
  state.started = true; state.iteration = 3; state.branch = "US-082-agent-constellation";
  const plan = state.steps[0]!;
  plan.status = "done"; plan.startedAt = now - 300_000; plan.finishedAt = now - 240_000;
  const step = state.steps[1]!;
  step.status = "running"; step.sessionID = "ses_build"; step.startedAt = now - 123_000;
  step.outputEvents = [{ kind: "assistant.text", text: "Building the agent constellation." }, { kind: "tool.started", tool: "edit", input: { filePath: "src/constellation.ts" } }];
  step.outputLines = ["Building the agent constellation.", "Each satellite reports its own activity.", "Full output stays available here."];
  step.outputLineTimes = step.outputLines.map(() => now);
  if (withInspection) {
    step.promptText = "Build an agent constellation behind a feature flag.\nKeep every running agent's activity visible, preserve full output, and verify keyboard and mouse interaction.";
    step.inspection = inspectSessionMessages("ses_build", [assistantMessage("ses_build", { modelID: "gpt-5.5" })]);
  }
  state.selectedStepIndex = 1; state.activeStepIndex = 1;
  step.backgroundAgents = [
    createBackgroundAgent("ses_components", now - 93_000, { agent: "components", title: "Build the activity bubbles", activity: "busy", parentSessionID: "ses_build", depth: 1 }),
    createBackgroundAgent("ses_tests", now - 78_000, { agent: "unit tests", title: "Verify the activity feed", activity: "busy", parentSessionID: "ses_build", depth: 1 }),
    createBackgroundAgent("ses_keyboard", now - 41_000, { agent: "keyboard", title: "Audit keyboard navigation", activity: "busy", parentSessionID: "ses_components", depth: 2 }),
    createBackgroundAgent("ses_docs", now - 32_000, { agent: "docs", title: "Document the new view", activity: "busy", parentSessionID: "ses_build", depth: 1 }),
    createBackgroundAgent("ses_explore", now - 220_000, { agent: "explore", title: "Inspect existing UI", activity: "idle", parentSessionID: "ses_build", depth: 1, finishedAt: now - 130_000 }),
  ];
  const summaries = ["Writing the second component", "Running unit tests", "Checking keyboard navigation", "Writing the usage guide", "Mapped the existing UI"];
  step.backgroundAgents.forEach((agent, i) => {
    agent.activitySummary = { text: summaries[i]!, observedAt: now };
    if (!withInspection) return;
    agent.promptText = `${agent.title}.\nCoordinate with the parent agent and report your results.`;
    agent.inspection = inspectSessionMessages(agent.sessionID, [assistantMessage(agent.sessionID, { modelID: "gpt-5.5", agent: agent.agent })]);
    agent.outputEvents = [
      { kind: "assistant.text", text: `${summaries[i]}.\nThe agent overview stays visible while each child reports its own progress.` },
      { kind: "tool.started", tool: "bash", input: { command: "bun test test/constellation.test.ts" } },
      { kind: "tool.done", tool: "bash", output: "(pass) live summaries remain visible\n(pass) parent connections match session ownership\n(pass) completed agents remain available\n3 pass · 0 fail" },
      { kind: "assistant.text", text: "The focused checks passed. I am checking the remaining interactions before reporting back." },
    ];
    agent.outputEventTimes = agent.outputEvents.map(() => now);
  });
  state.todos = [
    { content: "Inspect the UI", status: "completed", priority: "high" },
    { content: "Build bubbles", status: "in_progress", priority: "high" },
    { content: "Verify interactions", status: "pending", priority: "high" },
    { content: "Document the feature flag", status: "pending", priority: "medium" },
  ];
  state.branchDiff = { kind: "ok", additions: 248, deletions: 36, files: 8 };
  state.prd = { kind: "ok", remaining: 6, total: 12 };
  state.github = { kind: "no-pr" };
  return state;
}
