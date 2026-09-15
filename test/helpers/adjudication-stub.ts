import type { StoryTransitionRecord } from "../../src/lib/adjudication-detection.ts";
import type { AdjudicationCompletionRecord } from "../../src/lib/adjudication-files.ts";
import type { AdjudicateSession, AdjudicationStore } from "../../src/persistence/adjudication-store.ts";
import { CorruptAdjudicateSessionError } from "../../src/persistence/adjudication-store.ts";
import type { AdjudicationRequest } from "../../src/persistence/adjudication-request.ts";

export type InMemoryAdjudicationStore = AdjudicationStore & { readonly writeAgentMarker: (reason: string) => void };

export function createInMemoryAdjudicationStore(): InMemoryAdjudicationStore {
  let marker: AdjudicationRequest | null = null;
  let history: StoryTransitionRecord[] = [];
  let adjudicatedThrough = 0;
  let session: AdjudicateSession | null = null;
  let completions: AdjudicationCompletionRecord[] = [];

  return {
    markerExists: () => marker !== null,
    readMarker: () => marker?.reason ?? null,
    readRequest: () => marker,
    completeSession: (sessionID) => {
      if (session === null || session.sessionID !== sessionID || session.request === undefined) {
        throw new CorruptAdjudicateSessionError();
      }
      completions = [...completions, { at: new Date().toISOString(), reason: session.request.reason }];
      adjudicatedThrough = history.length;
      // Mirrors acknowledgeAdjudicationRequest: drop the consumed request, and
      // also drop an agent-written (plaintext) marker left behind by the
      // adjudicator itself, which would otherwise re-route forever.
      if (marker !== null && (marker.id === session.request.id || marker.id.startsWith("legacy-"))) marker = null;
      session = null;
    },
    writeMarker: (reason) => {
      marker = { id: crypto.randomUUID(), reason };
    },
    /** Simulate an agent writing the plaintext marker file directly. */
    writeAgentMarker: (reason: string) => {
      marker = { id: `legacy-${crypto.randomUUID()}`, reason };
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
