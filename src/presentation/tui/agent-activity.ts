import { compactActivity, summarizeAgentActivity, type ActivityContext } from "../../core/agent-activity.ts";
import type { BackgroundAgent, LoopStep, PendingRequest } from "../../lib/state.ts";

const requestSummary = (request: PendingRequest) =>
  request.kind === "question" ? "Waiting for your answer" : "Waiting for approval";

export function stepActivitySummary(step: LoopStep, request?: PendingRequest, context?: ActivityContext): string {
  if (step.restartReason === "timeout") return "Timed out";
  if (step.restartReason === "manual") return "Restarted";
  if (request) return requestSummary(request);
  if (step.statusMessage) return compactActivity(step.statusMessage);
  switch (step.status) {
    case "waiting": return "Waiting for delegated work";
    case "pending": return "Awaiting turn";
    case "done": return "Work complete";
    case "skipped": return "Skipped";
    case "failed": return "Needs attention";
    default: return summarizeAgentActivity(step, step.outputEvents ?? [], context) ?? "Starting work";
  }
}

export function childActivitySummary(agent: BackgroundAgent, request?: PendingRequest, now = Date.now(), context?: ActivityContext): string {
  if (request) return requestSummary(request);
  if (agent.activity === "idle") return "Session idle";
  const hint = agent.activitySummary;
  if (hint) return now - hint.observedAt > 15_000 ? `Last: ${hint.text}` : hint.text;
  // Classic mode already streams the selected child's transcript; no extra polling.
  return summarizeAgentActivity(agent, agent.outputEvents ?? [], context) ?? "Waiting for activity";
}
