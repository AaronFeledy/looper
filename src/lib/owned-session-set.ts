import type { LooperSessionPurpose } from "./session-metadata.ts";
import { applyDelta, emptySnapshot, projectPreorder, type RegistryDelta } from "../core/agent-registry.ts";

export class OwnedSessionSet {
  readonly #primarySessionID: string;
  readonly #sessionIDs: Set<string>;
  #snapshot = emptySnapshot();
  #liveDeltas: RegistryDelta[] | undefined;

  constructor(primarySessionID: string) {
    this.#primarySessionID = primarySessionID;
    this.#sessionIDs = new Set([primarySessionID]);
  }

  addChild(sessionID: string, purpose?: LooperSessionPurpose): void {
    if (purpose === "title") return;
    this.apply({ kind: "upsert", session: { id: sessionID, parentID: this.#primarySessionID, createdAt: 0 } });
  }

  removeChild(sessionID: string): void {
    if (sessionID === this.#primarySessionID) return;
    this.apply({ kind: "remove", sessionID });
  }

  beginBootstrap(): (deltas?: readonly RegistryDelta[]) => void {
    const journal: RegistryDelta[] = [];
    this.#liveDeltas = journal;
    return (deltas) => {
      this.#liveDeltas = undefined;
      if (deltas === undefined) return;
      this.#snapshot = emptySnapshot();
      this.#sessionIDs.clear();
      this.#sessionIDs.add(this.#primarySessionID);
      for (const delta of [...deltas, ...journal]) this.apply(delta);
    };
  }

  apply(delta: RegistryDelta): void {
    this.#liveDeltas?.push(delta);
    this.#snapshot = applyDelta(this.#snapshot, delta);
    this.#sessionIDs.clear();
    this.#sessionIDs.add(this.#primarySessionID);
    for (const child of projectPreorder(this.#snapshot, this.#primarySessionID)) this.#sessionIDs.add(child.sessionID);
  }

  ids(): ReadonlySet<string> {
    return this.#sessionIDs;
  }
}
