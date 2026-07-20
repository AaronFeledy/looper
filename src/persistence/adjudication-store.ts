import type { StoryTransitionRecord } from "../lib/adjudication-detection.ts";
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

export type AdjudicationStore = {
  readonly markerExists: () => boolean;
  readonly readMarker: () => string | null;
  readonly writeMarker: (reason: string) => void;
  readonly clearMarker: () => void;
  readonly appendHistory: (records: readonly StoryTransitionRecord[]) => void;
  readonly readHistory: () => StoryTransitionRecord[];
  readonly readActiveHistory: () => StoryTransitionRecord[];
  readonly markAdjudicated: () => void;
  readonly clearHistory: () => void;
  readonly writeSession: (session: AdjudicateSession) => void;
  readonly readSession: () => AdjudicateSession | null;
  readonly clearSession: () => void;
};

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
    readSession: readAdjudicateSession,
    clearSession: clearAdjudicateSession,
  };
}
