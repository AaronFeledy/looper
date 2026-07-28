import type { AgentRegistry } from "../opencode/agent-registry.ts";
import { syncStepAgentTree } from "./agent-tree-state.ts";
import { subscribe, type LoopState } from "./state.ts";

export function startAgentRegistryController({
  state,
  registry,
}: {
  readonly state: LoopState;
  readonly registry: AgentRegistry;
}): { stop: () => void } {
  let previousLeases = new Map<number, string>();
  let previousRoots = new Set<string>();
  let inSync = false;
  let rerunRequested = false;
  let stopped = false;

  const sync = (): void => {
    if (stopped) return;
    if (inSync) {
      rerunRequested = true;
      return;
    }

    inSync = true;
    try {
      do {
        rerunRequested = false;
        const leases = new Map<number, string>();
        for (const [stepIndex, step] of state.steps.entries()) {
          if ((step.status === "running" || step.status === "waiting") && step.sessionID !== undefined) {
            leases.set(stepIndex, step.sessionID);
          }
        }

        const roots = new Set(leases.values());
        const rootsChanged =
          roots.size !== previousRoots.size || [...roots].some((sessionID) => !previousRoots.has(sessionID));
        const priorLeases = previousLeases;
        previousLeases = leases;
        previousRoots = roots;

        if (rootsChanged) registry.setRoots([...roots]);
        for (const [stepIndex, sessionID] of leases) {
          syncStepAgentTree(state, stepIndex, registry.projectRoot(sessionID));
        }
        // Only prune on done. failed/skipped keep registry-projected rows so
        // failStepRow's "preserve background agents" contract holds in the TUI.
        for (const stepIndex of priorLeases.keys()) {
          if (leases.has(stepIndex)) continue;
          const step = state.steps[stepIndex];
          if (step === undefined) continue;
          if (step.status === "done") {
            syncStepAgentTree(state, stepIndex, []);
          }
        }
      } while (rerunRequested);
    } finally {
      inSync = false;
    }
  };

  const unsubscribeState = subscribe(sync);
  const unsubscribeRegistry = registry.subscribe(sync);
  sync();

  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      unsubscribeState();
      unsubscribeRegistry();
    },
  };
}
