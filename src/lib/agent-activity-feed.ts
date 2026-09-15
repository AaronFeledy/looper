import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { summarizeAgentActivity } from "../core/agent-activity.ts";
import { renderSession } from "./event-consumer.ts";
import { notify, subscribe, type BackgroundAgent, type LoopState } from "./state.ts";

/** All children get bounded summaries. The selected-only transcript streamer stays independent. */
export function startAgentActivityFeed({
  state, client, repoDir, refreshMs = 3_000, timeoutMs = 8_000,
}: {
  state: LoopState; client: OpencodeClient; repoDir: string; refreshMs?: number; timeoutMs?: number;
}): { stop(): void } {
  type Poll = { at: number; read: boolean; idle: boolean; controller?: AbortController };
  const polls = new Map<BackgroundAgent, Poll>();
  let stopped = false;
  let active = 0;
  const currentAgents = () => new Set(state.steps.flatMap((step) => step.backgroundAgents));

  const refresh = async (agent: BackgroundAgent, poll: Poll): Promise<void> => {
    const controller = new AbortController();
    poll.controller = controller;
    poll.at = Date.now();
    const idle = agent.activity === "idle";
    active++;
    try {
      const result = await client.session.messages(
        { sessionID: agent.sessionID, directory: repoDir, limit: 6 },
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) },
      );
      if (stopped || controller.signal.aborted || !currentAgents().has(agent) || result.error || !result.data) return;
      const text = summarizeAgentActivity(agent, renderSession(result.data).events, state.activityContext);
      if (text) agent.activitySummary = { text, observedAt: Date.now() };
      poll.read = true;
      poll.idle = idle;
      notify();
    } catch {
      // Keep the last observation; the view marks old observations as stale.
    } finally {
      delete poll.controller;
      active--;
      if (!stopped) pump();
    }
  };

  const pump = (): void => {
    if (stopped) return;
    const agents = currentAgents();
    for (const [agent, poll] of polls) {
      if (agents.has(agent)) continue;
      poll.controller?.abort();
      polls.delete(agent);
    }
    for (const agent of agents) {
      if (!polls.has(agent)) polls.set(agent, { at: -Infinity, read: false, idle: false });
    }
    // Oldest observation first: slow requests must not starve later satellites.
    const due = [...polls].filter(([agent, poll]) =>
      !poll.controller && Date.now() - poll.at >= refreshMs &&
      !(agent.activity === "idle" && poll.read && poll.idle),
    ).sort((a, b) => a[1].at - b[1].at);
    for (const [agent, poll] of due) {
      if (active >= 4) break;
      void refresh(agent, poll);
    }
  };
  const unsubscribe = subscribe(pump);
  const timer = setInterval(pump, refreshMs);
  timer.unref?.();
  pump();
  return { stop() {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    for (const poll of polls.values()) poll.controller?.abort();
    polls.clear();
  } };
}
