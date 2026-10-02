import { join } from "node:path";
import { UsageError } from "./args.ts";
import { readPrdStories, prdIndexPath } from "./prd.ts";
import { readResumeStep } from "./state-files.ts";
import { readAdjudicateSession } from "./adjudication-files.ts";
import { createRunStateStore } from "../persistence/run-state-store.ts";
import { isRecord } from "../opencode/util.ts";
import { commitPrdIdentity, normalizedPrdDir, parsePrdIdentity, PRD_RESET_FILE, PRD_STATE_FILES, readPrdStateSnapshot, type PrdStateSnapshot } from "../persistence/prd-identity-store.ts";

export type PrdStateDecision = "adopt" | "reset";
export type PrdStateChoice = { readonly previous: string | null | undefined; readonly current: string | null };
export type PrdProtectionInput = {
  readonly configDir: string;
  readonly repoDir: string;
  readonly prdDir?: string;
  readonly fresh: boolean;
  readonly decision?: PrdStateDecision;
  readonly choose?: (choice: PrdStateChoice) => Promise<PrdStateDecision>;
  readonly stopSessions: (ids: readonly string[], serverUrl?: string) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly confirmLegacyStopped?: boolean;
  readonly confirmShutdown?: () => Promise<boolean>;
  readonly freshCleanup?: "preserve-stories" | "reset-stories";
  readonly assertReady?: () => void;
};

export function recordedSessions(configDir: string, snapshot: PrdStateSnapshot): readonly string[] {
  const state = createRunStateStore({ configDir }).read();
  if (snapshot.has(".looper-resume-step.json") && readResumeStep() === null) {
    throw new UsageError("Invalid legacy checkpoint; reconcile it before changing PRD state");
  }
  const ids = new Set<string>();
  if (state?.sessionID) ids.add(state.sessionID);
  for (const step of state?.stepSessions ?? []) ids.add(step.sessionID);
  const adjudicator = readAdjudicateSession();
  switch (adjudicator.kind) {
    case "corrupt": throw new UsageError("Invalid adjudicator checkpoint; reconcile it before changing PRD state");
    case "ok": ids.add(adjudicator.session.sessionID); break;
    case "absent": break;
    default: { const unreachable: never = adjudicator; return unreachable; }
  }
  const trail = snapshot.get(".looper-agents.json");
  if (trail !== undefined) {
    const value: unknown = JSON.parse(trail);
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.agents)) {
      throw new UsageError("Invalid agent trail; reconcile child work before changing PRD state");
    }
    const agents: readonly unknown[] = value.agents;
    for (const entry of agents) {
      if (!isRecord(entry) || typeof entry.sessionID !== "string" || !Array.isArray(entry.children)) {
        throw new UsageError("Invalid agent trail entry; child work is unknown");
      }
      if (entry.status !== "done" || entry.finishedAt === undefined) ids.add(entry.sessionID);
      const children: readonly unknown[] = entry.children;
      for (const child of children) {
        if (!isRecord(child) || typeof child.sessionID !== "string") {
          throw new UsageError("Invalid agent trail child; child work is unknown");
        }
        if (child.finishedAt === undefined) {
          ids.add(entry.sessionID);
          ids.add(child.sessionID);
        }
      }
    }
  }
  return [...ids];
}

export async function preparePrdState(input: PrdProtectionInput): Promise<{ readonly archiveDir?: string }> {
  input.signal?.throwIfAborted();
  const snapshot = readPrdStateSnapshot(input.configDir);
  if (snapshot.has(PRD_RESET_FILE)) {
    throw new UsageError(`Interrupted PRD reset: inspect ${join(input.configDir, PRD_RESET_FILE)} and restore its archive before removing the reset marker`);
  }
  const previous = parsePrdIdentity(snapshot);
  const current = input.prdDir === undefined ? null : normalizedPrdDir(input.repoDir, input.prdDir);
  if (current !== null && readPrdStories(prdIndexPath(current)) === undefined) {
    throw new UsageError(`Configured PRD is unreadable: ${prdIndexPath(current)}; state was not changed`);
  }
  const hasState = PRD_STATE_FILES.some((name) => snapshot.has(name));
  let decision = input.decision;
  if (decision === undefined && previous?.prdDir !== current) {
    if (previous !== undefined && current !== null) decision = "reset";
    else if (hasState || previous !== undefined) {
      if (input.choose === undefined) {
        throw new UsageError("PRD state has no unambiguous association. Use --adopt-prd-state to keep it, or --reset-prd-state to archive and reset it");
      }
      decision = await input.choose({ previous: previous?.prdDir, current });
    }
  }
  const sessions = recordedSessions(input.configDir, snapshot);
  const migrating = (hasState || previous !== undefined) && previous?.writerProtocol !== 1;
  if (migrating && !input.confirmLegacyStopped && !(await input.confirmShutdown?.())) {
    throw new UsageError("Legacy frontend ownership is unknown. Stop ALL older Looper frontends for this config directory, then use --confirm-legacy-stopped. Adopt/reset consent and idle sessions do not prove frontend shutdown");
  }
  input.signal?.throwIfAborted();
  if (decision !== undefined || input.fresh || migrating) await input.stopSessions(sessions, previous?.serverUrl);
  input.signal?.throwIfAborted();
  if (previous?.prdDir === current && decision === undefined && !input.fresh && !migrating && input.freshCleanup === undefined) return {};
  const archiveDir = commitPrdIdentity({
    configDir: input.configDir, snapshot, reset: decision === "reset",
    identity: { version: 1, prdDir: current, writerProtocol: 1, ...(previous?.serverUrl ? { serverUrl: previous.serverUrl } : {}) },
    fresh: input.freshCleanup,
    assertReady: input.assertReady,
  });
  return archiveDir === undefined ? {} : { archiveDir };
}
