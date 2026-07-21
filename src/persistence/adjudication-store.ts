import type { AdjudicationStore } from "../engine/engine-ports.ts";
import {
  adjudicateMarkerExists,
  appendPrdHistory,
  clearAdjudicateMarker,
  clearAdjudicateSession,
  clearPrdHistory,
  markPrdHistoryAdjudicated,
  readActivePrdHistory,
  readAdjudicateMarker,
  readAdjudicateSession,
  readPrdHistory,
  writeAdjudicateMarker,
  writeAdjudicateSession,
  type AdjudicateSession,
} from "../lib/adjudication-files.ts";
import { initStatePaths } from "../lib/state-files.ts";

export type { AdjudicateSession } from "../lib/adjudication-files.ts";
export type { AdjudicationStore } from "../engine/engine-ports.ts";

export class CorruptAdjudicateSessionError extends Error {
  constructor() {
    super("adjudicator session record is corrupt; refusing to start a potentially overlapping generation");
    this.name = "CorruptAdjudicateSessionError";
  }
}

function readSessionFailClosed(): AdjudicateSession | null {
  const result = readAdjudicateSession();
  switch (result.kind) {
    case "absent":
      return null;
    case "ok":
      return result.session;
    case "corrupt":
      throw new CorruptAdjudicateSessionError();
  }
}

export function createAdjudicationStore(opts: { readonly configDir: string }): AdjudicationStore {
  initStatePaths({ configDir: opts.configDir });
  return {
    markerExists: adjudicateMarkerExists,
    readMarker: readAdjudicateMarker,
    writeMarker: writeAdjudicateMarker,
    clearMarker: clearAdjudicateMarker,
    appendHistory: appendPrdHistory,
    readHistory: readPrdHistory,
    // Detection window: only transitions after the last completed adjudication,
    // so a resolved oscillation cannot retrigger from its own old flips.
    readActiveHistory: readActivePrdHistory,
    markAdjudicated: markPrdHistoryAdjudicated,
    // PRD transition history is forensic cross-iteration data. Clear it only
    // for an explicit fresh run, never as part of max-iteration run cleanup.
    clearHistory: clearPrdHistory,
    writeSession: writeAdjudicateSession,
    readSession: readSessionFailClosed,
    clearSession: clearAdjudicateSession,
  };
}
