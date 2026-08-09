import type { LooperSessionPurpose } from "./session-metadata.ts";

export class OwnedSessionSet {
  readonly #primarySessionID: string;
  readonly #sessionIDs: Set<string>;

  constructor(primarySessionID: string) {
    this.#primarySessionID = primarySessionID;
    this.#sessionIDs = new Set([primarySessionID]);
  }

  addChild(sessionID: string, purpose?: LooperSessionPurpose): void {
    if (purpose === "title") return;
    this.#sessionIDs.add(sessionID);
  }

  removeChild(sessionID: string): void {
    if (sessionID === this.#primarySessionID) return;
    this.#sessionIDs.delete(sessionID);
  }

  ids(): ReadonlySet<string> {
    return this.#sessionIDs;
  }
}
