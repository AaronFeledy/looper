import { describe, expect, test } from "bun:test";

import {
  applyDelta,
  descendsFrom,
  emptySnapshot,
  projectPreorder,
  type RegistrySnapshot,
  type SessionFacts,
} from "../src/core/agent-registry.ts";

function snapshotOf(...sessions: readonly SessionFacts[]): RegistrySnapshot {
  return sessions.reduce(
    (snapshot, session) => applyDelta(snapshot, { kind: "upsert", session }),
    emptySnapshot(),
  );
}

describe("agent registry", () => {
  test("projects a single child under the root at depth one", () => {
    // Given
    const snapshot = snapshotOf({ id: "child", parentID: "root", agent: "build", title: "Implement", createdAt: 10 });

    // When
    const projected = projectPreorder(snapshot, "root");

    // Then
    expect(projected).toEqual([
      {
        sessionID: "child",
        parentSessionID: "root",
        depth: 1,
        agent: "build",
        title: "Implement",
        activity: "idle",
        startedAt: 10,
      },
    ]);
  });

  test("projects a grandchild after its parent with increasing depth", () => {
    // Given
    const snapshot = snapshotOf(
      { id: "parent", parentID: "root", createdAt: 10 },
      { id: "grandchild", parentID: "parent", createdAt: 20 },
    );

    // When
    const projected = projectPreorder(snapshot, "root");

    // Then
    expect(projected.map(({ sessionID, depth }) => ({ sessionID, depth }))).toEqual([
      { sessionID: "parent", depth: 1 },
      { sessionID: "grandchild", depth: 2 },
    ]);
  });

  test("excludes title sessions identified by metadata purpose", () => {
    // Given
    const snapshot = emptySnapshot();

    // When
    const next = applyDelta(snapshot, {
      kind: "upsert",
      session: { id: "title", parentID: "root", createdAt: 10, metadata: { purpose: "title" } },
    });

    // Then
    expect(next).toBe(snapshot);
    expect(projectPreorder(next, "root")).toEqual([]);
  });

  test("excludes title sessions identified by agent name", () => {
    // Given
    const snapshot = emptySnapshot();

    // When
    const next = applyDelta(snapshot, {
      kind: "upsert",
      session: { id: "title", parentID: "root", agent: "looper-title", createdAt: 10 },
    });

    // Then
    expect(next).toBe(snapshot);
    expect(projectPreorder(next, "root")).toEqual([]);
  });

  test("orders siblings by creation time and then session ID", () => {
    // Given
    const snapshot = snapshotOf(
      { id: "later", parentID: "root", createdAt: 20 },
      { id: "same-b", parentID: "root", createdAt: 10 },
      { id: "same-a", parentID: "root", createdAt: 10 },
    );

    // When
    const projected = projectPreorder(snapshot, "root");

    // Then
    expect(projected.map(({ sessionID }) => sessionID)).toEqual(["same-a", "same-b", "later"]);
  });

  test("removing a parent drops its complete subtree", () => {
    // Given
    const snapshot = snapshotOf(
      { id: "parent", parentID: "root", createdAt: 10 },
      { id: "child", parentID: "parent", createdAt: 20 },
      { id: "grandchild", parentID: "child", createdAt: 30 },
      { id: "sibling", parentID: "root", createdAt: 40 },
    );

    // When
    const next = applyDelta(snapshot, { kind: "remove", sessionID: "parent" });

    // Then
    expect(projectPreorder(next, "root").map(({ sessionID }) => sessionID)).toEqual(["sibling"]);
  });

  test("ignores activity changes received before an upsert", () => {
    // Given
    const snapshot = emptySnapshot();

    // When
    const next = applyDelta(snapshot, { kind: "activity", sessionID: "unknown", activity: "busy" });

    // Then
    expect(next).toBe(snapshot);
  });

  test("projects cyclic ancestry without revisiting the root", () => {
    // Given
    const snapshot = snapshotOf(
      { id: "A", parentID: "B", createdAt: 10 },
      { id: "B", parentID: "A", createdAt: 20 },
    );

    // When
    const projected = projectPreorder(snapshot, "A");

    // Then
    expect(projected.map(({ sessionID, depth }) => ({ sessionID, depth }))).toEqual([{ sessionID: "B", depth: 1 }]);
    expect(descendsFrom(snapshot, "B", "A")).toBe(true);
  });

  test("isolates projections and ancestry checks to the selected root", () => {
    // Given
    const snapshot = snapshotOf(
      { id: "one", parentID: "root-one", createdAt: 10 },
      { id: "two", parentID: "root-two", createdAt: 20 },
    );

    // When
    const projected = projectPreorder(snapshot, "root-one");

    // Then
    expect(projected.map(({ sessionID }) => sessionID)).toEqual(["one"]);
    expect(descendsFrom(snapshot, "two", "root-one")).toBe(false);
  });

  test("returns a new map without mutating the input snapshot", () => {
    // Given
    const originalNode = {
      sessionID: "existing",
      parentSessionID: "root",
      activity: "idle" as const,
      createdAt: 10,
    };
    const originalMap = new Map([[originalNode.sessionID, originalNode]]);
    const snapshot: RegistrySnapshot = { nodes: originalMap };

    // When
    const next = applyDelta(snapshot, {
      kind: "upsert",
      session: { id: "new", parentID: "root", createdAt: 20 },
    });

    // Then
    expect(next.nodes).not.toBe(originalMap);
    expect([...originalMap.entries()]).toEqual([["existing", originalNode]]);
  });
});
