import { AGENT_MAX_LINES, displayStepAt } from "./state.ts";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { renderSession, type SessionRender } from "./event-consumer.ts";
import { firstSessionPrompt, inspectSessionMessages } from "./session-inspection.ts";
import {
  clearBackgroundAgentBuffer, notify, pushBackgroundAgentLines, replaceBackgroundAgentEvents, subscribe,
  type BackgroundAgent, type LoopState, type LoopStep,
} from "./state.ts";

type Target = { sessionID: string; stepIndex: number; owner: BackgroundAgent | LoopStep; background: boolean };
type ActiveStream = { target: Target; timer: ReturnType<typeof setInterval>; controller: AbortController; reading: boolean };

function selectedTarget(state: LoopState): Target | null {
  // In the constellation, selecting a bubble is cheap. Full transcripts load when inspected.
  if (state.constellation && (!state.constellation.detailsOpen || state.historyView !== null)) return null;
  const stepIndex = state.selectedStepIndex ?? (state.constellation ? state.activeStepIndex : null);
  if (stepIndex === null) return null;
  const step = displayStepAt(state, stepIndex);
  if (!step) return null;
  const sessionID = state.selectedBackgroundSessionID;
  if (sessionID !== null) {
    const owner = step.backgroundAgents.find((agent) => agent.sessionID === sessionID);
    return owner ? { sessionID, stepIndex, owner, background: true } : null;
  }
  // Parents already have a live output buffer; fetch only recent metadata for their inspector.
  return (state.constellation || stepIndex < 0) && step.sessionID ? { sessionID: step.sessionID, stepIndex, owner: step, background: false } : null;
}

export function startBackgroundAgentStreamer({
  state, client, repoDir, refreshMs = 3_000, timeoutMs = 8_000,
}: {
  state: LoopState; client: OpencodeClient; repoDir: string; refreshMs?: number; timeoutMs?: number;
}): { stop: () => void } {
  let active: ActiveStream | null = null;
  let stopped = false;

  const replaceBuffer = (target: Target, rendered: SessionRender): void => {
    const agent = target.owner as BackgroundAgent;
    agent.outputLines = [];
    agent.outputLineTimes = [];
    agent.outputEvents = [];
    agent.outputEventTimes = [];
    if (rendered.lines.length === 0 && rendered.events.length === 0) { agent.outputScrollTop = 0; notify(); return; }
    pushBackgroundAgentLines(state, target.stepIndex, target.sessionID, rendered.lines, rendered.lineTimes);
    replaceBackgroundAgentEvents(state, target.stepIndex, target.sessionID, rendered.events, rendered.eventTimes);
  };

  const refresh = async (lease: ActiveStream): Promise<void> => {
    if (lease.reading || lease.controller.signal.aborted) return;
    lease.reading = true;
    const target = lease.target;
    try {
      const result = await client.session.messages(
        { sessionID: target.sessionID, directory: repoDir, ...(target.background || target.stepIndex < 0 ? {} : { limit: 6 }) },
        { signal: AbortSignal.any([lease.controller.signal, AbortSignal.timeout(timeoutMs)]) },
      );
      if (stopped || active !== lease || lease.controller.signal.aborted || selectedTarget(state)?.owner !== target.owner || selectedTarget(state)?.sessionID !== target.sessionID) return;
      if (result.error || !result.data) throw new Error("The server did not return session messages.");
      if (state.constellation) {
        target.owner.inspection = inspectSessionMessages(target.sessionID, result.data);
        if (target.background) target.owner.promptText = firstSessionPrompt(result.data, target.sessionID);
      }
      if (target.background) replaceBuffer(target, renderSession(result.data));
      else if (target.stepIndex < 0) {
        const rendered = renderSession(result.data, new Set((target.owner as LoopStep).looperMessageIDs ?? []));
        target.owner.outputLines = rendered.lines.slice(-AGENT_MAX_LINES);
        target.owner.outputLineTimes = rendered.lineTimes.slice(-AGENT_MAX_LINES);
        target.owner.outputEvents = rendered.events.slice(-AGENT_MAX_LINES);
        target.owner.outputEventTimes = rendered.eventTimes.slice(-AGENT_MAX_LINES);
      }
      notify();
    } catch (error) {
      if (stopped || active !== lease || lease.controller.signal.aborted || selectedTarget(state)?.owner !== target.owner || selectedTarget(state)?.sessionID !== target.sessionID) return;
      const message = error instanceof Error ? error.message : String(error);
      if (state.constellation) {
        target.owner.inspection = { ...target.owner.inspection, sessionID: target.sessionID, status: "error", error: message };
        notify();
      }
      if (process.env.LOOPER_DEBUG_EVENTS === "1") console.error(`[looper] background agent stream: refresh failed: ${message}`);
    } finally { lease.reading = false; }
  };

  const stopActive = (): void => {
    const lease = active;
    if (!lease) return;
    active = null;
    clearInterval(lease.timer);
    lease.controller.abort();
    if (!lease.target.background && lease.target.stepIndex < 0) {
      const owner = lease.target.owner;
      owner.outputLines = []; owner.outputLineTimes = [];
      owner.outputEvents = []; owner.outputEventTimes = [];
    }
    if (lease.target.background && displayStepAt(state, lease.target.stepIndex)?.backgroundAgents.includes(lease.target.owner as BackgroundAgent))
      clearBackgroundAgentBuffer(state, lease.target.stepIndex, lease.target.sessionID);
  };

  const sync = (): void => {
    if (stopped) return;
    const target = selectedTarget(state);
    if (!target) { stopActive(); return; }
    if (active?.target.owner === target.owner && active.target.sessionID === target.sessionID) return;
    stopActive();
    const lease: ActiveStream = {
      target, controller: new AbortController(), reading: false,
      timer: setInterval(() => { void refresh(lease); }, refreshMs),
    };
    lease.timer.unref?.();
    active = lease;
    if (state.constellation) {
      const previous = target.owner.inspection?.sessionID === target.sessionID ? target.owner.inspection : undefined;
      target.owner.inspection = { ...previous, sessionID: target.sessionID, status: "loading" };
      notify();
    }
    void refresh(lease);
  };

  const unsubscribe = subscribe(sync);
  sync();
  return { stop() { stopped = true; unsubscribe(); stopActive(); } };
}
