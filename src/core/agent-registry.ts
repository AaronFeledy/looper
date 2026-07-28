export type AgentActivity = "busy" | "idle";

export type RegistryNode = {
  sessionID: string;
  parentSessionID?: string;
  agent?: string;
  title?: string;
  activity: AgentActivity;
  createdAt: number;
};

export type RegistrySnapshot = { nodes: ReadonlyMap<string, RegistryNode> };

export type SessionFacts = {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  createdAt: number;
  metadata?: Readonly<Record<string, unknown>>;
};

export type RegistryDelta =
  | { kind: "upsert"; session: SessionFacts }
  | { kind: "remove"; sessionID: string }
  | { kind: "activity"; sessionID: string; activity: AgentActivity };

export type ProjectedAgent = {
  sessionID: string;
  parentSessionID: string;
  depth: number;
  agent?: string;
  title?: string;
  activity: AgentActivity;
  startedAt: number;
};

function assertNever(value: never): never {
  throw new Error(`unhandled registry delta: ${JSON.stringify(value)}`);
}

export function emptySnapshot(): RegistrySnapshot {
  return { nodes: new Map() };
}

export function isTitleSession(facts: SessionFacts): boolean {
  return facts.metadata?.["purpose"] === "title" || facts.agent === "looper-title";
}

export function descendsFrom(snapshot: RegistrySnapshot, sessionID: string, rootSessionID: string): boolean {
  if (sessionID === rootSessionID) return false;
  const visited = new Set<string>([sessionID]);
  let parentSessionID = snapshot.nodes.get(sessionID)?.parentSessionID;

  while (parentSessionID !== undefined) {
    if (parentSessionID === rootSessionID) return true;
    if (visited.has(parentSessionID)) return false;
    visited.add(parentSessionID);
    parentSessionID = snapshot.nodes.get(parentSessionID)?.parentSessionID;
  }

  return false;
}

export function applyDelta(snapshot: RegistrySnapshot, delta: RegistryDelta): RegistrySnapshot {
  switch (delta.kind) {
    case "upsert": {
      if (isTitleSession(delta.session)) return snapshot;
      const existing = snapshot.nodes.get(delta.session.id);
      const node: RegistryNode = {
        sessionID: delta.session.id,
        ...(delta.session.parentID === undefined ? {} : { parentSessionID: delta.session.parentID }),
        ...(delta.session.agent === undefined ? {} : { agent: delta.session.agent }),
        ...(delta.session.title === undefined ? {} : { title: delta.session.title }),
        activity: existing?.activity ?? "idle",
        createdAt: delta.session.createdAt,
      };
      const nodes = new Map(snapshot.nodes);
      nodes.set(node.sessionID, node);
      return { nodes };
    }
    case "remove": {
      const nodes = new Map(snapshot.nodes);
      for (const sessionID of snapshot.nodes.keys()) {
        if (sessionID === delta.sessionID || descendsFrom(snapshot, sessionID, delta.sessionID)) nodes.delete(sessionID);
      }
      return { nodes };
    }
    case "activity": {
      const existing = snapshot.nodes.get(delta.sessionID);
      if (existing === undefined) return snapshot;
      const nodes = new Map(snapshot.nodes);
      nodes.set(delta.sessionID, { ...existing, activity: delta.activity });
      return { nodes };
    }
    default:
      return assertNever(delta);
  }
}

export function projectPreorder(
  snapshot: RegistrySnapshot,
  rootSessionID: string,
  maxDepth = Number.POSITIVE_INFINITY,
): ProjectedAgent[] {
  const children = new Map<string, RegistryNode[]>();
  for (const node of snapshot.nodes.values()) {
    if (node.parentSessionID === undefined) continue;
    const siblings = children.get(node.parentSessionID) ?? [];
    siblings.push(node);
    children.set(node.parentSessionID, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.createdAt - right.createdAt || (left.sessionID < right.sessionID ? -1 : left.sessionID > right.sessionID ? 1 : 0));
  }

  const projected: ProjectedAgent[] = [];
  const visited = new Set<string>([rootSessionID]);
  const pending = (children.get(rootSessionID) ?? []).toReversed().map((node) => ({ node, depth: 1 }));

  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    if (visited.has(item.node.sessionID)) continue;
    visited.add(item.node.sessionID);
    if (item.depth > maxDepth) continue;
    const parentSessionID = item.node.parentSessionID;
    if (parentSessionID === undefined) continue;

    projected.push({
      sessionID: item.node.sessionID,
      parentSessionID,
      depth: item.depth,
      ...(item.node.agent === undefined ? {} : { agent: item.node.agent }),
      ...(item.node.title === undefined ? {} : { title: item.node.title }),
      activity: item.node.activity,
      startedAt: item.node.createdAt,
    });
    for (const child of (children.get(item.node.sessionID) ?? []).toReversed()) {
      pending.push({ node: child, depth: item.depth + 1 });
    }
  }

  return projected;
}
