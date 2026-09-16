import { selectedInspectorTarget } from "../../lib/agent-inspector-state.ts";
import { backgroundAgentLabel, prdPassingGain, type LoopState } from "../../lib/state.ts";

export function inspectorTitle(state: LoopState): string {
  const target = selectedInspectorTarget(state);
  return target ? `Agent · ${target.agent ? backgroundAgentLabel(target.agent) : target.step.name}` : "Run context";
}

export function inspectorMetadataLine(state: LoopState): string {
  const target = selectedInspectorTarget(state), owner = target?.agent ?? target?.step;
  const inspection = owner?.inspection?.sessionID === owner?.sessionID ? owner?.inspection : undefined;
  const metadata = inspection?.metadata;
  const source = metadata?.source === "requested" ? " (requested)" : "";
  const variantSource = metadata?.variantSource === "requested" ? " (requested)" : "";
  const model = metadata?.model ?? (owner?.sessionID ? "not reported" : "no session yet");
  const variant = metadata?.variant ?? "not reported";
  return `Model: ${model}${source}   Variant: ${variant}${variantSource}`;
}

export function inspectorDetailLines(state: LoopState): string[] {
  const target = selectedInspectorTarget(state);
  if (!target) return ["No agent selected."];
  const { step, agent, stepIndex } = target, owner = agent ?? step;
  const inspection = owner.inspection?.sessionID === owner.sessionID ? owner.inspection : undefined;
  const metadata = inspection?.metadata;
  const lines = [
    `Name: ${agent ? backgroundAgentLabel(agent) : step.name}`,
    `Role: ${metadata?.agent ?? agent?.agent ?? "not reported"}`,
    `Status: ${agent ? agent.activity ?? "unknown" : step.restartReason === "timeout" ? "Timed out" : step.restartReason === "manual" ? "Restarted" : step.status}`,
    inspectorMetadataLine(state),
    `Session: ${owner.sessionID ?? "not created yet"}`,
  ];
  if (agent) lines.push(`Parent session: ${agent.parentSessionID ?? step.sessionID ?? "unknown"}`, `Owning agent: ${step.name}`);
  if (owner.title) lines.push(`Title: ${owner.title}`);
  if (owner.startedAt !== undefined) lines.push(`Started: ${new Date(owner.startedAt).toLocaleString()}`);
  if (owner.finishedAt !== undefined) lines.push(`Finished: ${new Date(owner.finishedAt).toLocaleString()}`);
  if (step.statusMessage) lines.push(`${agent ? "Parent status" : "Status detail"}: ${step.statusMessage}`);
  if (step.restartReason) lines.push(`Restart reason: ${step.restartReason}`);
  if (step.continuation) lines.push(`Continuation: ${step.continuation.reason}`, `Waiting since: ${new Date(step.continuation.since).toLocaleString()}`);
  if (state.activeStepIndex === stepIndex && !agent) {
    const timeout = state.control.timeoutSnapshot();
    if (timeout) lines.push("", `Timeout remaining: ${Math.ceil(timeout.remainingMs / 60_000)} min`, `Original timeout: ${Math.ceil(timeout.originalMs / 60_000)} min`);
  }
  if (metadata) {
    lines.push("", `Latest message: ${metadata.messageID}`);
    if (metadata.finish) lines.push(`Finish reason: ${metadata.finish}`);
    if (metadata.cost !== undefined) lines.push(`Latest message cost: $${metadata.cost.toFixed(4)}`);
    if (metadata.tokens) {
      const t = metadata.tokens;
      lines.push(`Latest message tokens: ${t.input} input · ${t.output} output · ${t.reasoning} reasoning`,
        `Cache: ${t.cacheRead} read · ${t.cacheWrite} written`);
    }
  }
  if (inspection?.status === "loading") lines.push("", "Loading session details…");
  if (inspection?.status === "error") lines.push("", `Session details unavailable: ${inspection.error}`, "Showing the last available data; retrying.");
  if (inspection?.observedAt) lines.push(`Last checked: ${new Date(inspection.observedAt).toLocaleTimeString()}`);
  lines.push("", "c opens the complete Looper configuration.", "Output retains tool details, timing, costs, and reasoning blocks.");
  return lines;
}

export function inspectorDetails(state: LoopState): string {
  return inspectorDetailLines(state).join("\n");
}

export function inspectorPrompt(state: LoopState): string {
  const target = selectedInspectorTarget(state);
  if (!target) return "No agent selected.";
  if (target.agent) return target.agent.promptText ??
    (target.agent.inspection?.status === "error" ? `Unable to load the agent prompt: ${target.agent.inspection.error}` :
      target.agent.inspection?.status === "loading" ? "Loading the agent's original prompt…" : "No original user prompt was reported for this child session. Its full conversation is in Output.");
  return target.step.promptText ?? "No stored Looper prompt for this agent yet. c opens the configured prompt paths.";
}

/** Complete project details, including the less prominent fields of every former sidebar panel. */
export function inspectorContext(state: LoopState): string {
  const lines = [`Branch: ${state.branch || "detached"}`, `Iteration: ${state.iteration}/${state.maxIterations}`, "", "CHANGES"];
  const diff = state.branchDiff;
  if (diff.kind === "ok") lines.push(`${diff.files} files · +${diff.additions} / -${diff.deletions}`);
  else if (diff.kind === "error") lines.push(`Error: ${diff.message}`);
  else lines.push(diff.kind === "loading" ? "Loading changes…" : "No branch diff available.");

  lines.push("", "PULL REQUEST");
  const github = state.github;
  if (github.kind === "pr") {
    const pr = github.pr;
    lines.push(`#${pr.number} · ${pr.isDraft ? "draft · " : ""}${pr.state.toLowerCase()} · ${pr.title}`, pr.url,
      `CI: ${pr.ciOverall} · ${pr.ciPassing} passing · ${pr.ciFailing} failing · ${pr.ciPending} pending · ${pr.ciNeutral} neutral / ${pr.ciTotal} total`,
      `Mergeability: ${pr.mergeable}`);
    if (pr.bugbot) lines.push(`Bugbot: ${pr.bugbot.state}${pr.bugbot.unresolved !== undefined ? ` · ${pr.bugbot.unresolved} unresolved` : ""}`);
    lines.push("b opens this pull request in your browser.");
  } else lines.push(github.kind === "error" ? `Error: ${github.message}` : github.kind === "loading" ? "Loading PR…" : "No pull request.");

  lines.push("", "STORIES");
  const prd = state.prd;
  if (prd.kind === "ok") {
    const gain = prdPassingGain(prd, state.prdIterationBaseline);
    lines.push(`${prd.total - prd.remaining}/${prd.total} complete · ${prd.remaining} remaining · terminal ${prd.terminal ?? "merged"}`,
      `Complete gain this iteration: +${gain}${gain >= 2 ? " · WARNING: multiple stories advanced" : ""}`);
  } else lines.push(prd.kind === "error" ? `Error: ${prd.message}` : "Loading stories…");

  lines.push("", `WORK PLAN · ${state.steps[state.activeStepIndex ?? -1]?.name ?? "latest agent"}`);
  if (!state.todos.length) lines.push("No todos reported.");
  else state.todos.forEach((todo) => lines.push(`[${todo.status}] (${todo.priority}) ${todo.content}`));

  if (state.pendingRequests.length) {
    lines.push("", "WAITING ON YOU");
    state.pendingRequests.forEach((request) => lines.push(`${request.kind} · ${request.sessionID} · ${request.status}`));
  }
  return lines.join("\n");
}
