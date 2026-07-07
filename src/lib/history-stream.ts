import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { renderSessionEvents, renderSessionMessages } from "./event-consumer.ts";
import {
  historyStepSessionKey,
  selectedHistoryStep,
  setHistoryViewError,
  setHistoryViewEvents,
  setHistoryViewOutput,
  subscribe,
  type LoopState,
} from "./state.ts";

function formatError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return error instanceof Error ? error.message : String(error);
}

export function startHistoryStreamer({
  state,
  client,
  repoDir,
}: {
  state: LoopState;
  client: OpencodeClient;
  repoDir: string;
}): { stop: () => void } {
  const inflight = new Set<string>();

  const fetch = async (sessionKey: string, sessionID: string): Promise<void> => {
    if (inflight.has(sessionKey)) return;
    inflight.add(sessionKey);
    try {
      const result = await client.session.messages({ sessionID, directory: repoDir });
      if (result.error || !result.data) {
        setHistoryViewError(state, sessionKey, result.error ? formatError(result.error) : "no messages returned");
        return;
      }
      const lines = renderSessionMessages(result.data);
      const events = renderSessionEvents(result.data);
      const now = Date.now();
      setHistoryViewOutput(state, sessionKey, lines, lines.map(() => now));
      setHistoryViewEvents(state, sessionKey, events);
    } catch (error) {
      setHistoryViewError(state, sessionKey, formatError(error));
    } finally {
      inflight.delete(sessionKey);
    }
  };

  const sync = (): void => {
    const view = state.historyView;
    if (view === null) return;
    const selected = selectedHistoryStep(state);
    const sessionID = selected?.step.sessionID;
    const sessionKey = historyStepSessionKey(view.entryIndex, view.stepIndex, sessionID);
    if (sessionKey === null || sessionID === undefined) return;
    if (sessionKey === view.sessionKey) return;
    void fetch(sessionKey, sessionID);
  };

  const unsubscribe = subscribe(sync);
  sync();

  return { stop: () => unsubscribe() };
}
