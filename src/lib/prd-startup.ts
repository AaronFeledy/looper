import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { createInterface } from "node:readline/promises";
import { UsageError, type Options } from "./args.ts";
import { preparePrdState, recordedSessions, type PrdStateChoice, type PrdStateDecision } from "./prd-state-protection.ts";
import { stopPrdSessions } from "./prd-session-safety.ts";
import { commitPrdIdentity, parsePrdIdentity, readPrdStateSnapshot } from "../persistence/prd-identity-store.ts";
import type { RunLease } from "../persistence/run-lease.ts";

async function choosePrdState(choice: PrdStateChoice): Promise<PrdStateDecision> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await terminal.question(
      `PRD state association requires a decision.\nPrevious: ${choice.previous ?? "unrecorded / no PRD"}\nConfigured: ${choice.current ?? "no PRD"}\nType adopt to keep existing state, reset to archive and start clean, or Enter to cancel: `,
    );
    switch (answer.trim().toLowerCase()) {
      case "adopt": return "adopt";
      case "reset": return "reset";
      default: throw new UsageError("PRD state unchanged; use --adopt-prd-state or --reset-prd-state when ready");
    }
  } finally {
    terminal.close();
  }
}

export type PrdStartupGuard = {
  readonly acceptServer: (url: string, validate: () => Promise<void>) => Promise<void>;
  readonly fresh: () => Promise<void>;
};

async function confirmLegacyShutdown(): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await terminal.question("Stop ALL older Looper frontends using this config directory. An idle agent is not enough. Type stopped to acknowledge frontend shutdown, or Enter to cancel: ")).trim() === "stopped";
  } finally { terminal.close(); }
}

export async function protectPrdStartup(input: {
  readonly configDir: string;
  readonly repoDir: string;
  readonly prdDir?: string;
  readonly attachUrl?: string;
  readonly options: Options;
  readonly interactive: boolean;
  readonly signal?: AbortSignal;
  readonly ownership: RunLease;
}): Promise<PrdStartupGuard> {
  input.ownership.assertOwned();
  const stopSessions = async (sessionIDs: readonly string[], recordedUrl?: string): Promise<void> => {
    if (sessionIDs.length === 0) return;
    input.ownership.assertOwned();
    const baseUrl = recordedUrl ?? input.options.attachUrl;
    if (baseUrl === undefined) {
      throw new UsageError("Recorded work has no known server. Re-run with --attach=<original-server-url> to confirm-stop it before changing PRD state");
    }
    await stopPrdSessions({ client: createOpencodeClient({ baseUrl }), repoDir: input.repoDir, sessionIDs });
    input.ownership.assertOwned();
  };
  const protection = {
    configDir: input.configDir, repoDir: input.repoDir, prdDir: input.prdDir,
    signal: input.signal, stopSessions, assertReady: input.ownership.assertOwned,
  };
  const result = await preparePrdState({
    ...protection, fresh: input.options.fresh, decision: input.options.prdStateDecision,
    confirmLegacyStopped: input.options.confirmLegacyStopped,
    ...(input.interactive ? { choose: choosePrdState } : {}),
    ...(input.interactive ? { confirmShutdown: confirmLegacyShutdown } : {}),
  });
  if (result.archiveDir !== undefined) process.stderr.write(`[looper] PRD state archived: ${result.archiveDir}\n`);
  return {
    async acceptServer(serverUrl, validate) {
      input.ownership.assertOwned();
      const snapshot = readPrdStateSnapshot(input.configDir);
      const identity = parsePrdIdentity(snapshot);
      if (identity === undefined || identity.writerProtocol !== 1) throw new UsageError("Startup identity changed; restart and reconcile frontend ownership");
      const sessions = recordedSessions(input.configDir, snapshot);
      await validate();
      input.signal?.throwIfAborted();
      if (sessions.length > 0 && identity.serverUrl !== serverUrl) {
        const authority = identity.serverUrl ?? input.options.attachUrl;
        if (authority === undefined) throw new UsageError("Saved work has no proven server authority; use --attach=<original-server-url> before switching servers");
        await stopSessions(sessions, authority);
      }
      input.signal?.throwIfAborted();
      input.ownership.assertOwned();
      commitPrdIdentity({ configDir: input.configDir, snapshot, identity: { ...identity, serverUrl }, reset: false, assertReady: input.ownership.assertOwned });
    },
    async fresh() {
      input.ownership.assertOwned();
      await preparePrdState({ ...protection, fresh: true,
        freshCleanup: input.options.resetStories ? "reset-stories" : "preserve-stories" });
    },
  };
}
