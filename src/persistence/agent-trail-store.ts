import { join } from "node:path";
import { tolerantRead, tolerantRm, writeFileAtomically } from "../lib/state-files.ts";

export type AgentTrailChild = {
  sessionID: string; parentSessionID?: string; depth: number; agent?: string; title?: string;
  startedAt: number; finishedAt?: number;
};
export type AgentTrailEntry = {
  sessionID: string; name: string; status: "done" | "failed" | "skipped"; iteration: number;
  title?: string; statusMessage?: string; promptText?: string; looperMessageIDs?: string[];
  restartReason?: "manual" | "timeout"; startedAt?: number; finishedAt?: number;
  children: AgentTrailChild[];
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function strings(value: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap(key => typeof value[key] === "string" ? [[key, value[key]]] : []));
}
function times(value: Record<string, unknown>) {
  return { ...(finite(value.startedAt) ? { startedAt: value.startedAt } : {}),
    ...(finite(value.finishedAt) ? { finishedAt: value.finishedAt } : {}) };
}
function parseChild(value: unknown): AgentTrailChild[] {
  if (!record(value) || !nonempty(value.sessionID) || !finite(value.startedAt) || !finite(value.depth) || !Number.isInteger(value.depth)) return [];
  return [{ sessionID: value.sessionID, depth: value.depth, startedAt: value.startedAt,
    ...strings(value, ["parentSessionID", "agent", "title"]), ...times(value) }];
}
function parseEntry(value: unknown): AgentTrailEntry[] {
  if (!record(value) || !nonempty(value.sessionID) || !nonempty(value.name)
    || !finite(value.iteration) || !Number.isInteger(value.iteration)
    || (value.status !== "done" && value.status !== "failed" && value.status !== "skipped")) return [];
  return [{ sessionID: value.sessionID, name: value.name, status: value.status, iteration: value.iteration,
    ...strings(value, ["title", "statusMessage", "promptText"]), ...times(value),
    ...(value.restartReason === "manual" || value.restartReason === "timeout" ? { restartReason: value.restartReason } : {}),
    ...(Array.isArray(value.looperMessageIDs) ? { looperMessageIDs: value.looperMessageIDs.filter(nonempty) } : {}),
    children: Array.isArray(value.children) ? value.children.flatMap(parseChild) : [],
  }];
}

/** Kept separately from the advancing run pointer, including after max_iterations. */
export function createAgentTrailStore(configDir: string) {
  const path = join(configDir, ".looper-agents.json");
  return {
    read(): AgentTrailEntry[] {
      try {
        const content = tolerantRead(path);
        const value: unknown = content === null ? null : JSON.parse(content);
        if (!record(value) || value.version !== 1 || !Array.isArray(value.agents)) return [];
        return [...new Map(value.agents.flatMap(parseEntry).map(entry => [entry.sessionID, entry])).values()];
      } catch { return []; }
    },
    write(agents: AgentTrailEntry[]) { writeFileAtomically(path, `${JSON.stringify({ version: 1, agents }, null, 2)}\n`); },
    clear() { tolerantRm(path); },
  };
}
