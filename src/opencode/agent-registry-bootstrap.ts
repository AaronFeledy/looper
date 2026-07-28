import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2";

import { isTitleSession, type RegistryDelta, type SessionFacts } from "../core/agent-registry.ts";
import { formatRequestError } from "./util.ts";

const MAX_BOOTSTRAP_DEPTH = 6;
const MAX_BOOTSTRAP_NODES = 200;

export type BootstrapResult =
  | { readonly kind: "success"; readonly deltas: readonly RegistryDelta[] }
  | { readonly kind: "failure"; readonly message: string };

function sessionFacts(session: Session): SessionFacts {
  return {
    id: session.id,
    ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
    ...(session.agent === undefined ? {} : { agent: session.agent }),
    ...(session.title.length === 0 ? {} : { title: session.title }),
    createdAt: session.time.created,
    ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
  };
}

export async function bootstrapAgentRoot({
  client,
  repoDir,
  rootSessionID,
  signal,
}: {
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly rootSessionID: string;
  readonly signal: AbortSignal;
}): Promise<BootstrapResult> {
  const statusResult = await client.session.status({ directory: repoDir }, { signal });
  if (statusResult.error) return { kind: "failure", message: `session.status failed: ${formatRequestError(statusResult.error)}` };
  if (!statusResult.data) return { kind: "failure", message: "session.status returned no data" };

  const deltas: RegistryDelta[] = [];
  const visited = new Set<string>([rootSessionID]);
  const pending: { readonly sessionID: string; readonly depth: number }[] = [{ sessionID: rootSessionID, depth: 0 }];
  let discovered = 0;

  while (pending.length > 0 && discovered < MAX_BOOTSTRAP_NODES) {
    const parent = pending.shift();
    if (parent === undefined) break;
    const childrenResult = await client.session.children({ sessionID: parent.sessionID, directory: repoDir }, { signal });
    if (childrenResult.error) {
      return { kind: "failure", message: `session.children failed: ${formatRequestError(childrenResult.error)}` };
    }
    if (!childrenResult.data) return { kind: "failure", message: "session.children returned no data" };

    for (const child of childrenResult.data) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      discovered += 1;
      const facts = sessionFacts(child);
      if (!isTitleSession(facts)) {
        deltas.push({ kind: "upsert", session: facts });
        deltas.push({
          kind: "activity",
          sessionID: child.id,
          activity: statusResult.data[child.id]?.type === "busy" || statusResult.data[child.id]?.type === "retry" ? "busy" : "idle",
        });
      }
      if (parent.depth + 1 < MAX_BOOTSTRAP_DEPTH) pending.push({ sessionID: child.id, depth: parent.depth + 1 });
      if (discovered >= MAX_BOOTSTRAP_NODES) break;
    }
  }

  return { kind: "success", deltas };
}
