import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { renderSession, type SessionRender } from "./event-consumer.ts";
import {
  clearBackgroundAgentBuffer,
  notify,
  pushBackgroundAgentLines,
  replaceBackgroundAgentEvents,
  subscribe,
  type LoopState,
} from "./state.ts";

const REFRESH_INTERVAL_MS = 3_000;

type ActiveStream = {
  sessionID: string;
  stepIndex: number;
  timer: ReturnType<typeof setInterval>;
};

function selectedTarget(state: LoopState): { sessionID: string; stepIndex: number } | null {
  const sessionID = state.selectedBackgroundSessionID;
  const stepIndex = state.selectedStepIndex;
  if (sessionID === null || stepIndex === null) return null;
  const step = state.steps[stepIndex];
  if (!step) return null;
  if (!step.backgroundAgents.some((agent) => agent.sessionID === sessionID && !agent.placeholder)) return null;
  return { sessionID, stepIndex };
}

export function startBackgroundAgentStreamer({
  state,
  client,
  repoDir,
}: {
  state: LoopState;
  client: OpencodeClient;
  repoDir: string;
}): { stop: () => void } {
  let active: ActiveStream | null = null;

  const replaceBuffer = (stepIndex: number, sessionID: string, rendered: SessionRender): void => {
    const step = state.steps[stepIndex];
    if (!step) return;
    const agent = step.backgroundAgents.find((candidate) => candidate.sessionID === sessionID);
    if (!agent) return;
    agent.outputLines = [];
    agent.outputLineTimes = [];
    agent.outputEvents = [];
    agent.outputEventTimes = [];
    if (rendered.lines.length === 0 && rendered.events.length === 0) {
      agent.outputScrollTop = 0;
      notify();
      return;
    }
    pushBackgroundAgentLines(state, stepIndex, sessionID, rendered.lines, rendered.lineTimes);
    replaceBackgroundAgentEvents(state, stepIndex, sessionID, rendered.events, rendered.eventTimes);
  };

  const inflight = new Set<string>();
  const refresh = async (target: { sessionID: string; stepIndex: number }): Promise<void> => {
    if (inflight.has(target.sessionID)) return;
    inflight.add(target.sessionID);
    try {
      const result = await client.session.messages({ sessionID: target.sessionID, directory: repoDir });
      if (result.error || !result.data) return;
      if (active === null || active.sessionID !== target.sessionID) return;
      replaceBuffer(target.stepIndex, target.sessionID, renderSession(result.data));
    } catch (error) {
      if (process.env.LOOPER_DEBUG_EVENTS === "1") console.error(`[looper] background agent stream: refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inflight.delete(target.sessionID);
    }
  };

  const stopActive = (): void => {
    if (active === null) return;
    clearInterval(active.timer);
    clearBackgroundAgentBuffer(state, active.stepIndex, active.sessionID);
    active = null;
  };

  const ensureActive = (target: { sessionID: string; stepIndex: number }): void => {
    if (active && active.sessionID === target.sessionID && active.stepIndex === target.stepIndex) return;
    stopActive();
    const timer = setInterval(() => {
      void refresh(target);
    }, REFRESH_INTERVAL_MS);
    active = { sessionID: target.sessionID, stepIndex: target.stepIndex, timer };
    void refresh(target);
  };

  const sync = (): void => {
    const target = selectedTarget(state);
    if (target === null) {
      stopActive();
      return;
    }
    ensureActive(target);
  };

  const unsubscribe = subscribe(sync);
  sync();

  return {
    stop: () => {
      unsubscribe();
      stopActive();
    },
  };
}
