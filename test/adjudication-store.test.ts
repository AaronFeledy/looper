import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { StoryTransitionRecord } from "../src/lib/adjudication-detection.ts";
import { createAdjudicationStore, type AdjudicationStore } from "../src/persistence/adjudication-store.ts";
import { createInMemoryAdjudicationStore } from "./helpers/adjudication-stub.ts";

const FIRST_TRANSITION: StoryTransitionRecord = {
  storyId: "US-1",
  from: true,
  to: false,
  iteration: 2,
  stepName: "build",
  at: "2026-07-19T12:00:00.000Z",
};

const SECOND_TRANSITION: StoryTransitionRecord = {
  storyId: "US-1",
  from: false,
  to: true,
  iteration: 3,
  stepName: "review",
  at: "2026-07-19T12:05:00.000Z",
};

type StoreHarness = {
  readonly store: AdjudicationStore;
  readonly cleanup: () => void;
};

function runStoreContract(name: string, makeHarness: () => StoreHarness): void {
  describe(name, () => {
    let harness: StoreHarness;

    beforeEach(() => {
      harness = makeHarness();
    });

    afterEach(() => {
      harness.cleanup();
    });

    test("writes, reads, and clears the adjudication marker", () => {
      harness.store.writeMarker("resolve conflicting acceptance criteria");

      expect(harness.store.markerExists()).toBe(true);
      expect(harness.store.readMarker()).toBe("resolve conflicting acceptance criteria");

      harness.store.clearMarker();

      expect(harness.store.markerExists()).toBe(false);
      expect(harness.store.readMarker()).toBeNull();
    });

    test("appends, reads, and clears transition history", () => {
      harness.store.appendHistory([FIRST_TRANSITION]);
      harness.store.appendHistory([SECOND_TRANSITION]);

      expect(harness.store.readHistory()).toEqual([FIRST_TRANSITION, SECOND_TRANSITION]);

      harness.store.clearHistory();

      expect(harness.store.readHistory()).toEqual([]);
    });

    test("marker clearing preserves transition history", () => {
      harness.store.writeMarker("adjudicate");
      harness.store.appendHistory([FIRST_TRANSITION]);

      harness.store.clearMarker();

      expect(harness.store.readHistory()).toEqual([FIRST_TRANSITION]);
    });

    test("history clearing preserves the marker", () => {
      harness.store.writeMarker("adjudicate");
      harness.store.appendHistory([FIRST_TRANSITION]);

      harness.store.clearHistory();

      expect(harness.store.readMarker()).toBe("adjudicate");
    });

    test("marking adjudicated windows the active history but retains the full trail", () => {
      harness.store.appendHistory([FIRST_TRANSITION]);
      harness.store.markAdjudicated();
      harness.store.appendHistory([SECOND_TRANSITION]);

      expect(harness.store.readActiveHistory()).toEqual([SECOND_TRANSITION]);
      expect(harness.store.readHistory()).toEqual([FIRST_TRANSITION, SECOND_TRANSITION]);
    });

    test("writes, reads, and clears the adjudicator session record", () => {
      harness.store.writeSession({ sessionID: "ses_adj", messageID: "msg_adj" });
      expect(harness.store.readSession()).toEqual({ sessionID: "ses_adj", messageID: "msg_adj" });

      harness.store.clearSession();
      expect(harness.store.readSession()).toBeNull();
    });
  });
}

runStoreContract("file-backed adjudication store", () => {
  const configDir = mkdtempSync(join(import.meta.dir, ".tmp", "adjudication-store-"));
  return {
    store: createAdjudicationStore({ configDir }),
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
  };
});

runStoreContract("in-memory adjudication store", () => ({
  store: createInMemoryAdjudicationStore(),
  cleanup: () => {},
}));

describe("adjudication store paths", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(import.meta.dir, ".tmp", "adjudication-store-paths-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("writes marker and history files inside the configured directory", () => {
    const store = createAdjudicationStore({ configDir });

    store.writeMarker("adjudicate");
    store.appendHistory([FIRST_TRANSITION]);

    expect(existsSync(join(configDir, ".looper-adjudicate"))).toBe(true);
    expect(existsSync(join(configDir, ".looper-prd-history.json"))).toBe(true);
  });
});
