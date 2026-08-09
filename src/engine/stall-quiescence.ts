import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import type { StepSessionEntry } from "../lib/state-files.ts";
import { readActiveProjectContinuationRecord } from "../opencode/continuation-records.ts";
import { probeBackgroundLiveness } from "../opencode/session-health.ts";
import { isRecord } from "../opencode/util.ts";
import type { StallObserver } from "./stall-detector.ts";

const SETTLE_POLL_MS = 250;

function supportsLivenessProbe(client: unknown): client is OpencodeClient {
  if (!isRecord(client)) return false;
  const session: unknown = client.session;
  return isRecord(session) && typeof session.children === "function" && typeof session.status === "function";
}

export type IterationLivenessSnapshot = {
  readonly sessions: readonly StepSessionEntry[];
  readonly startedAt: number;
};

export type InFlightProbeInput = {
  readonly repoDir: string;
  readonly client: unknown;
  readonly currentIteration: () => IterationLivenessSnapshot;
};

export function createInFlightProbe(input: InFlightProbeInput): () => Promise<boolean> {
  const client = input.client;
  return async () => {
    const { sessions, startedAt } = input.currentIteration();
    try {
      if (readActiveProjectContinuationRecord(input.repoDir, startedAt) !== null) return true;
      if (sessions.length === 0) return false;
      // Sessions exist but this client cannot answer for them, so liveness is
      // UNKNOWN rather than idle — and unknown fails open as "still working".
      if (!supportsLivenessProbe(client)) return true;
      for (const entry of sessions) {
        const probe = await probeBackgroundLiveness({ client, repoDir: input.repoDir, parentSessionID: entry.sessionID });
        if (probe.errorMessage !== undefined || probe.parent === "pending" || probe.pendingChildren.length > 0) return true;
      }
      return false;
    } catch {
      // no-excuse-ok: catch -- liveness became unknowable, and unknown fails open as "still working" so no strike is scored
      return true;
    }
  };
}

export async function waitForStallSettle(windowMs: number, shouldAbort: () => boolean): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, windowMs);
  while (Date.now() < deadline) {
    if (shouldAbort()) return false;
    await Bun.sleep(Math.min(SETTLE_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return !shouldAbort();
}

export type StallCheckOutcome = { readonly stopped: false } | { readonly stopped: true; readonly reason: string };

export type StallStopFiles = {
  readonly stopFileExists: () => boolean;
  readonly stopAfterIterationFileExists: () => boolean;
  readonly stopReason: () => string;
  readonly writeStop: (reason: string) => void;
};

export type StallCheckInput = {
  readonly observer: StallObserver;
  readonly confirmMs: number;
  readonly store: StallStopFiles;
  readonly currentBranch: () => Promise<string>;
};

export async function runStallCheck(input: StallCheckInput): Promise<StallCheckOutcome> {
  const verdict = await input.observer.checkIteration(await input.currentBranch());
  if (!verdict.stalled) return { stopped: false };
  const stopRequested = () => input.store.stopFileExists() || input.store.stopAfterIterationFileExists();
  if (!(await waitForStallSettle(input.confirmMs, stopRequested))) return { stopped: true, reason: input.store.stopReason() };
  if (!(await input.observer.confirmStall(await input.currentBranch()))) return { stopped: false };
  input.store.writeStop(verdict.reason);
  return { stopped: true, reason: verdict.reason };
}
