import type { Event, OpencodeClient, Session } from "@opencode-ai/sdk/v2";

import {
  applyDelta,
  emptySnapshot,
  isTitleSession,
  projectPreorder,
  type ProjectedAgent,
  type RegistryDelta,
  type RegistryNode,
  type RegistrySnapshot,
  type SessionFacts,
} from "../core/agent-registry.ts";
import { bootstrapAgentRoot } from "./agent-registry-bootstrap.ts";

const RECONNECT_BACKOFF_MS = 1_000;
const LAZY_BOOTSTRAP_DEBOUNCE_MS = 2_000;
const BOOTSTRAP_MAX_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_BASE_MS = 250;

export type AgentRegistry = {
  readonly setRoots: (rootSessionIDs: readonly string[]) => void;
  readonly projectRoot: (rootSessionID: string) => ProjectedAgent[];
  readonly subscribe: (listener: () => void) => () => void;
  readonly stop: () => void;
};

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

function nodesEqual(left: RegistryNode, right: RegistryNode): boolean {
  return (
    left.sessionID === right.sessionID &&
    left.parentSessionID === right.parentSessionID &&
    left.agent === right.agent &&
    left.title === right.title &&
    left.activity === right.activity &&
    left.createdAt === right.createdAt
  );
}

function snapshotsEqual(left: RegistrySnapshot, right: RegistrySnapshot): boolean {
  if (left.nodes.size !== right.nodes.size) return false;
  for (const [sessionID, leftNode] of left.nodes) {
    const rightNode = right.nodes.get(sessionID);
    if (rightNode === undefined || !nodesEqual(leftNode, rightNode)) return false;
  }
  return true;
}

function assertNever(value: never): never {
  throw new Error(`unhandled bootstrap result: ${JSON.stringify(value)}`);
}

function waitUnlessAborted(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function startAgentRegistry({
  client,
  repoDir,
  onError,
}: {
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly onError?: (message: string) => void;
}): AgentRegistry {
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  const roots = new Set<string>();
  const bootstrapInFlight = new Map<string, Promise<void>>();
  const bootstrapPending = new Set<string>();
  const lastLazyBootstrapAt = new Map<string, number>();
  const liveJournal: { readonly seq: number; readonly delta: RegistryDelta }[] = [];
  let snapshot = emptySnapshot();
  let stopped = false;
  let errorReported = false;
  let activeBootstraps = 0;
  let liveJournalSeq = 0;

  const reportError = (message: string): void => {
    if (errorReported) return;
    errorReported = true;
    onError?.(message);
  };

  const setSnapshot = (next: RegistrySnapshot): void => {
    if (snapshotsEqual(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  // A bootstrap response is a snapshot from when it was requested; journaled live deltas are replayed
  // on top of the commit so newer events that landed mid-flight are not overwritten by older state.
  const journalLiveDelta = (delta: RegistryDelta): void => {
    if (activeBootstraps === 0) return;
    liveJournalSeq += 1;
    liveJournal.push({ seq: liveJournalSeq, delta });
  };

  const commitBootstrap = (rootSessionID: string, deltas: readonly RegistryDelta[], sinceSeq: number): void => {
    if (stopped || !roots.has(rootSessionID)) return;
    let next = applyDelta(snapshot, { kind: "remove", sessionID: rootSessionID });
    for (const delta of deltas) next = applyDelta(next, delta);
    for (const entry of liveJournal) {
      if (entry.seq > sinceSeq) next = applyDelta(next, entry.delta);
    }
    setSnapshot(next);
  };

  const attemptBootstrap = async (rootSessionID: string): Promise<{ readonly failure?: string }> => {
    const sinceSeq = liveJournalSeq;
    try {
      const result = await bootstrapAgentRoot({ client, repoDir, rootSessionID, signal: controller.signal });
      if (stopped) return {};
      switch (result.kind) {
        case "success":
          commitBootstrap(rootSessionID, result.deltas, sinceSeq);
          return {};
        case "failure":
          return { failure: result.message };
        default:
          return assertNever(result);
      }
    } catch (error) {
      if (stopped || controller.signal.aborted) return {};
      return { failure: `agent registry bootstrap failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  // Without retries a transient SDK failure leaves the root registered but never re-bootstrapped, hiding
  // every already-running child until the next reconnect.
  const performBootstrap = async (rootSessionID: string): Promise<void> => {
    activeBootstraps += 1;
    try {
      for (let attempt = 1; ; attempt += 1) {
        const { failure } = await attemptBootstrap(rootSessionID);
        if (failure === undefined || stopped || controller.signal.aborted || !roots.has(rootSessionID)) return;
        if (attempt >= BOOTSTRAP_MAX_ATTEMPTS) {
          reportError(failure);
          return;
        }
        const waited = await waitUnlessAborted(controller.signal, BOOTSTRAP_RETRY_BASE_MS * 2 ** (attempt - 1));
        if (!waited || stopped || !roots.has(rootSessionID)) return;
      }
    } finally {
      activeBootstraps -= 1;
      if (activeBootstraps === 0) liveJournal.length = 0;
    }
  };

  const requestBootstrap = async (rootSessionID: string): Promise<void> => {
    if (stopped || !roots.has(rootSessionID)) return;
    const current = bootstrapInFlight.get(rootSessionID);
    if (current !== undefined) {
      bootstrapPending.add(rootSessionID);
      await current;
      return;
    }
    const run = performBootstrap(rootSessionID);
    bootstrapInFlight.set(rootSessionID, run);
    await run;
    if (bootstrapInFlight.get(rootSessionID) === run) bootstrapInFlight.delete(rootSessionID);
    if (bootstrapPending.delete(rootSessionID) && !stopped && roots.has(rootSessionID)) await requestBootstrap(rootSessionID);
  };

  const bootstrapRoots = async (): Promise<void> => {
    await Promise.all([...roots].map(requestBootstrap));
  };

  const parentChainUnknown = (facts: SessionFacts): boolean => {
    let parentSessionID = facts.parentID;
    if (parentSessionID === undefined) return false;
    const visited = new Set<string>();
    while (!roots.has(parentSessionID)) {
      if (visited.has(parentSessionID)) return true;
      visited.add(parentSessionID);
      const parent = snapshot.nodes.get(parentSessionID);
      if (parent?.parentSessionID === undefined) return true;
      parentSessionID = parent.parentSessionID;
    }
    return false;
  };

  const requestLazyBootstraps = (): void => {
    const now = Date.now();
    for (const rootSessionID of roots) {
      const previous = lastLazyBootstrapAt.get(rootSessionID);
      if (previous !== undefined && now - previous < LAZY_BOOTSTRAP_DEBOUNCE_MS) continue;
      lastLazyBootstrapAt.set(rootSessionID, now);
      void requestBootstrap(rootSessionID);
    }
  };

  const applyLiveDelta = (delta: RegistryDelta): void => {
    journalLiveDelta(delta);
    setSnapshot(applyDelta(snapshot, delta));
  };

  const upsertLiveSession = (session: Session): void => {
    const facts = sessionFacts(session);
    if (isTitleSession(facts)) {
      applyLiveDelta({ kind: "remove", sessionID: facts.id });
      return;
    }
    applyLiveDelta({ kind: "upsert", session: facts });
    if (parentChainUnknown(facts)) requestLazyBootstraps();
  };

  const handleEvent = (event: Event): void => {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        upsertLiveSession(event.properties.info);
        return;
      case "session.deleted":
        applyLiveDelta({ kind: "remove", sessionID: event.properties.sessionID });
        return;
      case "session.status":
        applyLiveDelta({
          kind: "activity",
          sessionID: event.properties.sessionID,
          activity: event.properties.status.type === "busy" || event.properties.status.type === "retry" ? "busy" : "idle",
        });
        return;
      case "session.idle":
        applyLiveDelta({ kind: "activity", sessionID: event.properties.sessionID, activity: "idle" });
        return;
      default:
        return;
    }
  };

  const consumeEvents = async (): Promise<void> => {
    while (!stopped) {
      try {
        const subscription = await client.event.subscribe({ directory: repoDir }, { signal: controller.signal });
        for await (const event of subscription.stream) {
          if (stopped) return;
          handleEvent(event);
        }
      } catch (error) {
        if (stopped || controller.signal.aborted) return;
        reportError(`agent registry event stream failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (stopped || !(await waitUnlessAborted(controller.signal, RECONNECT_BACKOFF_MS))) return;
      await bootstrapRoots();
    }
  };

  void consumeEvents();

  return {
    setRoots: (rootSessionIDs): void => {
      if (stopped) return;
      const nextRoots = new Set(rootSessionIDs);
      let next = snapshot;
      for (const rootSessionID of roots) {
        if (!nextRoots.has(rootSessionID)) next = applyDelta(next, { kind: "remove", sessionID: rootSessionID });
      }
      const addedRoots = [...nextRoots].filter((rootSessionID) => !roots.has(rootSessionID));
      roots.clear();
      for (const rootSessionID of nextRoots) roots.add(rootSessionID);
      setSnapshot(next);
      for (const rootSessionID of addedRoots) void requestBootstrap(rootSessionID);
    },
    projectRoot: (rootSessionID): ProjectedAgent[] => projectPreorder(snapshot, rootSessionID),
    subscribe: (listener): (() => void) => {
      if (stopped) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      roots.clear();
      bootstrapPending.clear();
      lastLazyBootstrapAt.clear();
      liveJournal.length = 0;
      setSnapshot(emptySnapshot());
      listeners.clear();
    },
  };
}
