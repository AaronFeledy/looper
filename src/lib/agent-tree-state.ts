import type { BackgroundAgent, LoopState, StepStatus } from "./state.ts";
import {
  completeGroupKey,
  createBackgroundAgent,
  isCompleteGroupSelectionId,
  notify,
  parseCompleteGroupSelection,
} from "./state.ts";

type ProjectedAgent = {
  readonly sessionID: string;
  readonly parentSessionID: string;
  readonly depth: number;
  readonly agent?: string;
  readonly title?: string;
  readonly activity: "busy" | "idle";
  readonly startedAt: number;
};

const RETAINS_MISSING_AGENTS = {
  pending: true,
  running: true,
  waiting: true,
  done: false,
  failed: false,
  skipped: false,
} as const satisfies Record<StepStatus, boolean>;

function updateAgentMetadata(existing: BackgroundAgent, incoming: ProjectedAgent): boolean {
  let changed = false;

  if (existing.startedAt !== incoming.startedAt) {
    existing.startedAt = incoming.startedAt;
    changed = true;
  }
  if (existing.depth !== incoming.depth) {
    existing.depth = incoming.depth;
    changed = true;
  }
  if (existing.parentSessionID !== incoming.parentSessionID) {
    existing.parentSessionID = incoming.parentSessionID;
    changed = true;
  }
  if (existing.agent !== incoming.agent) {
    if (incoming.agent === undefined) delete existing.agent;
    else existing.agent = incoming.agent;
    changed = true;
  }
  if (existing.title !== incoming.title) {
    if (incoming.title === undefined) delete existing.title;
    else existing.title = incoming.title;
    changed = true;
  }
  if (existing.activity !== incoming.activity) {
    existing.activity = incoming.activity;
    if (incoming.activity === "idle") {
      existing.finishedAt ??= Date.now();
    } else {
      delete existing.finishedAt;
    }
    changed = true;
  } else if (incoming.activity === "idle" && existing.finishedAt === undefined) {
    existing.finishedAt = Date.now();
    changed = true;
  }
  return changed;
}

export function syncStepAgentTree(state: LoopState, stepIndex: number, agents: ProjectedAgent[]): void {
  const step = state.steps[stepIndex];
  if (step === undefined) return;

  const existing = new Map(step.backgroundAgents.map((agent) => [agent.sessionID, agent]));
  const incomingIDs = new Set(agents.map(({ sessionID }) => sessionID));
  const merged: BackgroundAgent[] = [];
  let changed = false;

  for (const incoming of agents) {
    const current = existing.get(incoming.sessionID);
    if (current === undefined) {
      merged.push(createBackgroundAgent(incoming.sessionID, incoming.startedAt, incoming));
      changed = true;
      continue;
    }

    if (updateAgentMetadata(current, incoming)) changed = true;
    merged.push(current);
  }

  if (RETAINS_MISSING_AGENTS[step.status]) {
    for (const current of step.backgroundAgents) {
      if (incomingIDs.has(current.sessionID)) continue;
      // Deleted/dropped sessions must not keep spinning: force idle + stamp
      // finishedAt so the row collapses into Complete and duration freezes.
      if (current.activity !== "idle") {
        current.activity = "idle";
        current.finishedAt ??= Date.now();
        changed = true;
      } else if (current.finishedAt === undefined) {
        current.finishedAt = Date.now();
        changed = true;
      }
      merged.push(current);
    }
  }

  if (!changed && merged.length === step.backgroundAgents.length) {
    changed = merged.some((agent, index) => agent !== step.backgroundAgents[index]);
  } else if (merged.length !== step.backgroundAgents.length) {
    changed = true;
  }

  const retainedIDs = new Set(merged.map(({ sessionID }) => sessionID));
  if (state.selectedStepIndex === stepIndex && state.selectedBackgroundSessionID !== null) {
    const selectedID = state.selectedBackgroundSessionID;
    if (isCompleteGroupSelectionId(selectedID)) {
      const parentSessionID = parseCompleteGroupSelection(selectedID);
      if (parentSessionID !== undefined) {
        const hasIdleDirect = merged.some((agent) => {
          if (agent.activity !== "idle") return false;
          if (parentSessionID === null) {
            return agent.parentSessionID === step.sessionID || agent.depth === 1;
          }
          return agent.parentSessionID === parentSessionID;
        });
        if (!hasIdleDirect) {
          state.selectedBackgroundSessionID = null;
          state.expandedCompleteGroups.delete(completeGroupKey(stepIndex, parentSessionID));
          changed = true;
        }
      }
    } else if (!retainedIDs.has(selectedID)) {
      state.selectedBackgroundSessionID = null;
      changed = true;
    }
  }
  for (const key of [...state.expandedCompleteGroups]) {
    if (!key.startsWith(`${stepIndex}`) || (key !== `${stepIndex}` && !key.startsWith(`${stepIndex}:`))) continue;
    const parentSessionID = key === `${stepIndex}` ? null : key.slice(`${stepIndex}:`.length);
    const stillHasIdle = merged.some((agent) => {
      if (agent.activity !== "idle") return false;
      if (parentSessionID === null) {
        return step.sessionID !== undefined
          ? agent.parentSessionID === step.sessionID
          : agent.depth === 1;
      }
      return agent.parentSessionID === parentSessionID;
    });
    if (!stillHasIdle && state.expandedCompleteGroups.delete(key)) changed = true;
  }

  if (!changed) return;
  step.backgroundAgents = merged;
  notify();
}

export function setStepContinuation(
  state: LoopState,
  stepIndex: number,
  value: { reason: string; since: number } | null,
): void {
  const step = state.steps[stepIndex];
  if (step === undefined) return;

  if (value === null) {
    if (step.continuation === undefined) return;
    delete step.continuation;
    notify();
    return;
  }

  if (step.continuation?.reason === value.reason && step.continuation.since === value.since) return;
  step.continuation = { reason: value.reason, since: value.since };
  notify();
}
