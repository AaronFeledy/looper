import type { SessionMessageSnapshot } from "./session-inspection.ts";

export type AgentRunTimes = { startedAt: number; finishedAt: number };
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Old checkpoints have session IDs but no times. Use message timestamps,
 * never the session's updated time (renames can change it after completion). */
export function completedSessionTimes(sessionID: string, messages: readonly SessionMessageSnapshot[]): AgentRunTimes | undefined {
  const ordered = messages.map(message => message.info)
    .filter(info => info.sessionID === sessionID && timestamp(info.time.created))
    .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
  const first = ordered[0], last = ordered.at(-1);
  if (!first || last?.role !== "assistant" || !timestamp(last.time.completed)
    || last.time.completed < last.time.created) return;
  return { startedAt: first.time.created, finishedAt: last.time.completed };
}
