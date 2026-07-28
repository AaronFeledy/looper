import type { StoryTransitionRecord } from "../../src/lib/adjudication-detection.ts";
import type { AdjudicationCompletionRecord } from "../../src/lib/adjudication-files.ts";
import type { AdjudicateSession, AdjudicationStore } from "../../src/persistence/adjudication-store.ts";

export function createInMemoryAdjudicationStore(): AdjudicationStore {
  let marker: string | null = null;
  let history: StoryTransitionRecord[] = [];
  let adjudicatedThrough = 0;
  let session: AdjudicateSession | null = null;
  let completions: AdjudicationCompletionRecord[] = [];

  return {
    markerExists: () => marker !== null,
    readMarker: () => marker,
    writeMarker: (reason) => {
      marker = reason;
    },
    clearMarker: () => {
      marker = null;
    },
    appendHistory: (records) => {
      history = [...history, ...records];
    },
    readHistory: () => [...history],
    readActiveHistory: () => history.slice(adjudicatedThrough),
    markAdjudicated: () => {
      adjudicatedThrough = history.length;
    },
    clearHistory: () => {
      history = [];
      adjudicatedThrough = 0;
      completions = [];
    },
    appendCompletion: (record) => {
      completions = [...completions, record];
    },
    readCompletions: () => [...completions],
    writeSession: (next) => {
      session = next;
    },
    readSession: () => session,
    clearSession: () => {
      session = null;
    },
  };
}
