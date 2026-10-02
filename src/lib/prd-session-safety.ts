import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { join } from "node:path";
import { UsageError } from "./args.ts";
import { tolerantRead } from "./state-files.ts";
import { continuationDir, isSafeSessionID, parseContinuationRecord } from "../opencode/continuation-records.ts";
import { isPendingSessionStatus, stopServerSession } from "../opencode/session-health.ts";

export async function stopPrdSessions(input: {
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly sessionIDs: readonly string[];
}): Promise<void> {
  const { client, repoDir } = input;
  const ids = new Set(input.sessionIDs);
  const signal = AbortSignal.timeout(30_000);
  for (const sessionID of ids) {
    signal.throwIfAborted();
    if (ids.size > 1000 || !isSafeSessionID(sessionID)) throw new UsageError("Unsafe or unbounded session tree; refusing PRD reset");
    if (!(await stopServerSession({ client, repoDir, sessionID }))) {
      throw new UsageError(`Could not confirm stop of ${sessionID}; PRD state retained`);
    }
    const children = await client.session.children({ sessionID, directory: repoDir }, { signal });
    if (children.error || children.data === undefined) throw new UsageError(`Unknown child work for ${sessionID}; PRD state retained`);
    for (const child of children.data) ids.add(child.id);
  }
  // Re-enumerate after aborts: a parent may have delegated while it was stopping.
  for (const sessionID of ids) {
    const children = await client.session.children({ sessionID, directory: repoDir }, { signal });
    if (children.error || children.data === undefined || children.data.some(child => !ids.has(child.id))) {
      throw new UsageError(`Session tree changed or is unknown for ${sessionID}; retry PRD reconciliation`);
    }
    const raw = tolerantRead(join(continuationDir(repoDir), `${sessionID}.json`));
    if (raw !== null) {
      const continuation = parseContinuationRecord(raw);
      if (continuation === null || continuation.sessionID !== sessionID || continuation.source.state === "active") {
        throw new UsageError(`Unsettled background continuation for ${sessionID}; wait for or stop its producer before retrying`);
      }
    }
  }
  if (ids.size === 0) return;
  const status = await client.session.status({ directory: repoDir }, { signal });
  if (status.error || status.data === undefined || [...ids].some(id => isPendingSessionStatus(status.data?.[id]))) {
    throw new UsageError("Old session work is pending or unknown; PRD state retained");
  }
}
