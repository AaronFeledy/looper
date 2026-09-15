import { displayStepAt } from "./state.ts";
import { notify, type BackgroundAgent, type LoopState, type LoopStep } from "./state.ts";

export const INSPECTOR_TABS = ["output", "details", "prompt", "context"] as const;
export type InspectorTab = typeof INSPECTOR_TABS[number];

export function selectedInspectorTarget(state: LoopState): { step: LoopStep; stepIndex: number; agent?: BackgroundAgent } | undefined {
  const stepIndex = state.selectedStepIndex ?? state.activeStepIndex ?? (state.steps.length ? 0 : null);
  if (stepIndex === null) return undefined;
  const step = displayStepAt(state, stepIndex);
  if (!step) return undefined;
  const agent = state.selectedBackgroundSessionID
    ? step.backgroundAgents.find((candidate) => candidate.sessionID === state.selectedBackgroundSessionID) : undefined;
  return { step, stepIndex, agent };
}

export function openAgentInspector(state: LoopState, tab: InspectorTab = "output"): void {
  if (!state.constellation || state.historyView !== null) return;
  const target = selectedInspectorTarget(state);
  if (target) {
    state.selectedStepIndex = target.stepIndex;
    state.selectedBackgroundSessionID = target.agent?.sessionID ?? null;
  }
  state.manualStepSelection = true;
  state.focusedPane = "output";
  state.constellation.detailsOpen = true;
  state.constellation.inspectorTab = tab;
  state.constellation.inspectorScroll = 0;
  state.constellation.planOpen = false;
  notify();
}

export function closeAgentInspector(state: LoopState): void {
  if (!state.constellation) return;
  state.constellation.detailsOpen = false;
  state.focusedPane = "steps";
  notify();
}

export function selectInspectorTab(state: LoopState, tab: InspectorTab): void {
  if (!state.constellation) return;
  state.constellation.inspectorTab = tab;
  state.constellation.inspectorScroll = 0;
  notify();
}

export function cycleInspectorTab(state: LoopState, delta: number): void {
  const current = INSPECTOR_TABS.indexOf(state.constellation?.inspectorTab ?? "output");
  selectInspectorTab(state, INSPECTOR_TABS[(current + delta + INSPECTOR_TABS.length) % INSPECTOR_TABS.length]!);
}
