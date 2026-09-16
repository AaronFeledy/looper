import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { completedSessionTimes } from "./agent-trail-timing.ts";
import { createBackgroundAgent, createStepRow, notify, subscribe, type LoopState, type LoopStep } from "./state.ts";
import { createAgentTrailStore, type AgentTrailEntry } from "../persistence/agent-trail-store.ts";

function snapshot(step: LoopStep, iteration: number): AgentTrailEntry | undefined {
  const status = step.status;
  if (!step.sessionID || (status !== "done" && status !== "failed" && status !== "skipped")) return;
  return {
    sessionID: step.sessionID, name: step.name, status,
    iteration: step.trailIteration ?? iteration,
    title: step.title, statusMessage: step.statusMessage, promptText: step.promptText,
    looperMessageIDs: step.looperMessageIDs ? [...step.looperMessageIDs] : undefined, restartReason: step.restartReason,
    startedAt: step.startedAt, finishedAt: step.startedAt === undefined ? undefined : step.finishedAt,
    children: step.backgroundAgents.map(agent => ({
      sessionID: agent.sessionID, parentSessionID: agent.parentSessionID, depth: agent.depth,
      agent: agent.agent, title: agent.title, startedAt: agent.startedAt,
      finishedAt: agent.finishedAt ?? step.finishedAt,
    })),
  };
}

function restore(entry: AgentTrailEntry): LoopStep {
  const { children, iteration, ...metadata } = entry;
  return {
    ...createStepRow(entry.name), ...metadata, trailIteration: iteration,
    backgroundAgents: children.map(child => ({
      ...createBackgroundAgent(child.sessionID, child.startedAt, { ...child, activity: "idle" }),
      finishedAt: child.finishedAt,
    })),
  };
}

/** Presentation-only history. Never supplies engine outcomes or resume positions. */
export function startAgentTrailPersistence(configDir: string, getState: () => LoopState | null) {
  const store = createAgentTrailStore(configDir);
  let entries = store.read();

  let attached: LoopState | null = null;
  let dirty = false;
  let writeError: string | undefined;
  let recovery: Promise<void> | undefined;
  let recoveryController = new AbortController();
  const capture = () => {
    const state = getState();
    if (!state) return;
    if (attached !== state) {
      state.retainedSteps = entries.map(restore);
      // Boot rows are synthesized from the resume pointer. Recover their exact
      // terminal metadata before a capture can overwrite it with placeholders.
      for (const step of state.steps) {
        const saved = entries.find(entry => entry.sessionID === step.sessionID && entry.status === step.status);
        if (saved && step.startedAt === undefined) Object.assign(step, restore(saved));
      }
      attached = state;
    }
    const positions = new Map(entries.map((entry, index) => [entry.sessionID, index]));
    for (const step of state.steps) {
      const entry = snapshot(step, state.iteration);
      if (!entry) continue;
      const index = positions.get(entry.sessionID);
      if (index === undefined) {
        positions.set(entry.sessionID, entries.length);
        entries.push(entry);
        dirty = true;
        state.retainedSteps.push(restore(entry));
      } else if (JSON.stringify(entries[index]) !== JSON.stringify(entry)) {
        entries[index] = entry;
        dirty = true;
        state.retainedSteps[index] = restore(entry);
      }
    }
    if (!dirty) return;
    try {
      store.write(entries); dirty = false; writeError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== writeError) console.error(`[looper] could not save agent trail: ${message}`);
      writeError = message;
    }
  };
  const recoverTimes = (client: OpencodeClient, repoDir: string): Promise<void> => {
    if (recovery) return recovery;
    const signal = recoveryController.signal;
    recovery = (async () => {
      // Sequential and bounded per session; this runs behind the UI, never on
      // the engine's critical path. New records already have their own times.
      for (const entry of [...entries]) {
        if (signal.aborted) break;
        if (entry.startedAt !== undefined && entry.finishedAt !== undefined) continue;
        try {
          const result = await client.session.messages(
            { sessionID: entry.sessionID, directory: repoDir },
            { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) },
          );
          if (signal.aborted || !entries.includes(entry) || result.error || !result.data) continue;
          const times = completedSessionTimes(entry.sessionID, result.data);
          if (!times) continue;
          // With no original start, the old finish may be a boot placeholder:
          // replace both. Otherwise preserve the measured start of the attempt.
          const recovered = { startedAt: entry.startedAt ?? times.startedAt,
            finishedAt: entry.startedAt === undefined ? times.finishedAt : entry.finishedAt ?? times.finishedAt };
          Object.assign(entry, recovered);
          const state = getState();
          if (state) for (const row of [...state.retainedSteps, ...state.steps]) {
            if (row.sessionID === entry.sessionID &&
              (row.status === "done" || row.status === "failed" || row.status === "skipped") &&
              (row.startedAt === undefined || row.finishedAt === undefined)) Object.assign(row, recovered);
          }
          dirty = true;
          capture();
          notify();
        } catch {
          // A missing/offline session cannot supply a trustworthy duration.
          // Leave it unknown and retry on the next recovery pass or restart.
        }
      }
    })().finally(() => { recovery = undefined; });
    return recovery;
  };
  const clear = () => {
    recoveryController.abort(); recoveryController = new AbortController();
    store.clear(); entries = []; dirty = false; writeError = undefined;
    const state = getState();
    if (state) { state.retainedSteps = []; state.history = []; state.historyView = null; }
  };
  // Hydrate before subscribing so restored metadata is available on the first paint.
  capture();
  const unsubscribe = subscribe(capture);
  return { capture, clear, recoverTimes, stop() { recoveryController.abort(); unsubscribe(); capture(); } };
}
