import { describe, expect, test } from "bun:test";

import { renderSessionMessages } from "../src/lib/event-consumer.ts";
import {
  clearBackgroundAgentBuffer,
  COMPLETE_GROUP_SESSION_ID,
  createBackgroundAgent,
  createLoopState,
  flattenRows,
  insertRestartAttempt,
  pushBackgroundAgentLines,
  selectNextStep,
  selectPreviousStep,
  selectStepListRow,
  setCompleteGroupExpanded,
  setFocusedPane,
  syncStepBackgroundAgents,
} from "../src/lib/state.ts";
import {
  backgroundAgentRowColor,
  durationSecondsFrom,
  formatRow,
  isLiveStepStatus,
  stepListStatusColor,
  stepListStatusIcon,
} from "../src/tui/step-list.ts";

function state(stepNames: string[]) {
  return createLoopState({ maxIterations: 1, stepNames });
}

function twoStepThreeAgentState() {
  const s = state(["build", "review"]);
  syncStepBackgroundAgents(s, 0, [
    { sessionID: "ses_a", startedAt: 1, agent: "explore" },
    { sessionID: "ses_b", startedAt: 2 },
  ]);
  syncStepBackgroundAgents(s, 1, [{ sessionID: "ses_c", startedAt: 3 }]);
  return s;
}

describe("flattenRows", () => {
  test("intersperses background sub-rows under their parent step", () => {
    const s = twoStepThreeAgentState();

    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      { kind: "background", stepIndex: 0, sessionID: "ses_a" },
      { kind: "background", stepIndex: 0, sessionID: "ses_b" },
      { kind: "step", stepIndex: 1 },
      { kind: "background", stepIndex: 1, sessionID: "ses_c" },
    ]);
  });

  test("inserts restart attempts as normal step rows", () => {
    const s = state(["build"]);
    const nextIndex = insertRestartAttempt(s, 0, "manual");
    syncStepBackgroundAgents(s, nextIndex, [{ sessionID: "ses_a", startedAt: 1 }]);

    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      { kind: "step", stepIndex: 1 },
      { kind: "background", stepIndex: 1, sessionID: "ses_a" },
    ]);
    expect(s.steps[0]?.restartReason).toBe("manual");
    expect(s.steps[1]?.restartReason).toBeUndefined();
  });
});

describe("syncStepBackgroundAgents", () => {
  test("preserves existing buffers and clears selection for removed agents", () => {
    const s = state(["build"]);
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1 }]);
    pushBackgroundAgentLines(s, 0, "ses_a", ["line one", "line two"]);
    s.selectedStepIndex = 0;
    s.selectedBackgroundSessionID = "ses_a";
    s.manualStepSelection = true;

    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1, agent: "explore" }]);
    expect(s.steps[0]?.backgroundAgents[0]?.outputLines).toEqual(["line one", "line two"]);
    expect(s.steps[0]?.backgroundAgents[0]?.agent).toBe("explore");

    syncStepBackgroundAgents(s, 0, []);
    expect(s.steps[0]?.backgroundAgents).toEqual([]);
    expect(s.selectedBackgroundSessionID).toBeNull();
  });

  test("replaces stale rows with the current registry snapshot", () => {
    const s = state(["review"]);
    syncStepBackgroundAgents(s, 0, [
      { sessionID: "ses_stale", startedAt: 1, title: "Stale agent" },
    ]);

    syncStepBackgroundAgents(s, 0, [
      { sessionID: "ses_child", startedAt: 2, agent: "general", title: "Trace subagent step UI" },
    ]);

    expect(s.steps[0]?.backgroundAgents).toMatchObject([
      { sessionID: "ses_child", agent: "general", title: "Trace subagent step UI" },
    ]);
  });
});

describe("selectNext/Previous traversal", () => {
  test("walks step-then-bg-then-next-step", () => {
    const s = state(["build", "review"]);
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1 }]);

    selectNextStep(s);
    expect(s.selectedStepIndex).toBe(0);
    expect(s.selectedBackgroundSessionID).toBeNull();

    selectNextStep(s);
    expect(s.selectedStepIndex).toBe(0);
    expect(s.selectedBackgroundSessionID).toBe("ses_a");

    selectNextStep(s);
    expect(s.selectedStepIndex).toBe(1);
    expect(s.selectedBackgroundSessionID).toBeNull();

    selectPreviousStep(s);
    expect(s.selectedStepIndex).toBe(0);
    expect(s.selectedBackgroundSessionID).toBe("ses_a");
  });
});

describe("selectStepListRow", () => {
  test("selects a live flat row by index and focuses steps", () => {
    const s = state(["build", "review"]);
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1 }]);
    setFocusedPane(s, "output");

    selectStepListRow(s, 1);
    expect(s.focusedPane).toBe("steps");
    expect(s.selectedStepIndex).toBe(0);
    expect(s.selectedBackgroundSessionID).toBe("ses_a");
    expect(s.manualStepSelection).toBe(true);

    selectStepListRow(s, 2);
    expect(s.selectedStepIndex).toBe(1);
    expect(s.selectedBackgroundSessionID).toBeNull();
  });

  test("ignores out-of-range live row indexes", () => {
    const s = state(["build"]);
    selectStepListRow(s, 5);
    expect(s.selectedStepIndex).toBeNull();
    expect(s.manualStepSelection).toBe(false);
  });
});

describe("two-step three-agent selection characterization", () => {
  test("selectStepListRow maps the fourth flat row to the second step", () => {
    // Given
    const s = twoStepThreeAgentState();

    // When
    selectStepListRow(s, 3);

    // Then
    expect(s.selectedStepIndex).toBe(1);
    expect(s.selectedBackgroundSessionID).toBeNull();
    expect(s.manualStepSelection).toBe(true);
  });

  test("selectNextStep advances between adjacent agents under one step", () => {
    // Given
    const s = twoStepThreeAgentState();
    selectStepListRow(s, 1);

    // When
    const selected = selectNextStep(s);

    // Then
    expect(selected).toEqual({ kind: "background", stepIndex: 0, sessionID: "ses_b" });
    expect(s.selectedBackgroundSessionID).toBe("ses_b");
  });

  test("selectPreviousStep moves from the second step to its preceding agent", () => {
    // Given
    const s = twoStepThreeAgentState();
    selectStepListRow(s, 3);

    // When
    const selected = selectPreviousStep(s);

    // Then
    expect(selected).toEqual({ kind: "background", stepIndex: 0, sessionID: "ses_b" });
    expect(s.selectedStepIndex).toBe(0);
    expect(s.selectedBackgroundSessionID).toBe("ses_b");
  });

  test("syncStepBackgroundAgents clears selection when the selected agent disappears", () => {
    // Given
    const s = twoStepThreeAgentState();
    selectStepListRow(s, 1);

    // When
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_b", startedAt: 2 }]);

    // Then
    expect(s.selectedStepIndex).toBe(0);
    expect(s.selectedBackgroundSessionID).toBeNull();
  });

  test("syncStepBackgroundAgents preserves output lines for a surviving agent", () => {
    // Given
    const s = twoStepThreeAgentState();
    pushBackgroundAgentLines(s, 0, "ses_a", ["first", "second"]);

    // When
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 4, agent: "general" }]);

    // Then
    expect(s.steps[0]?.backgroundAgents[0]?.outputLines).toEqual(["first", "second"]);
  });
});

describe("clearBackgroundAgentBuffer", () => {
  test("drops accumulated lines but leaves the agent itself", () => {
    const s = state(["build"]);
    syncStepBackgroundAgents(s, 0, [{ sessionID: "ses_a", startedAt: 1 }]);
    pushBackgroundAgentLines(s, 0, "ses_a", ["x", "y"]);
    clearBackgroundAgentBuffer(s, 0, "ses_a");

    const agent = s.steps[0]?.backgroundAgents[0];
    expect(agent?.outputLines).toEqual([]);
    expect(agent?.outputLineTimes).toEqual([]);
    expect(agent?.sessionID).toBe("ses_a");
  });
});

describe("formatRow", () => {
  test("right-aligns the duration at the same column for ASCII and indented rows", () => {
    const parent = formatRow("✓ Sync", "1m");
    const subagent = formatRow("  ↳ ⠋ explore", "1m");
    expect(parent.endsWith("1m")).toBe(true);
    expect(subagent.endsWith("1m")).toBe(true);
    expect(parent.length).toBe(subagent.length);
  });

  test("truncates long labels with an ellipsis while keeping the duration intact", () => {
    const row = formatRow("  ↳ ⠋ a very long subagent title that overflows", "12m");
    expect(row.endsWith("12m")).toBe(true);
    expect(row).toContain("…");
  });
});

describe("renderSessionMessages", () => {
  test("emits both user and assistant text lines", () => {
    const lines = renderSessionMessages([
      {
        info: { id: "msg_u", role: "user" } as never,
        parts: [{ id: "p1", type: "text", text: "plugin user prompt", time: { end: 1 } } as never],
      },
      {
        info: { id: "msg_a", role: "assistant" } as never,
        parts: [{ id: "p2", type: "text", text: "hello\nworld\n", time: { end: 1 } } as never],
      },
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("plugin user prompt");
    expect(joined).toContain("hello");
    expect(joined).toContain("world");
  });
});

describe("durationSecondsFrom", () => {
  test("freezes at finishedAt for completed steps even as wall clock advances", () => {
    // Given a step that ran for 5s
    const startedAt = 1_000_000;
    const finishedAt = 1_005_000;
    // When duration is computed twice with different "now"
    const first = durationSecondsFrom(startedAt, finishedAt, { now: 1_005_000, live: false });
    const later = durationSecondsFrom(startedAt, finishedAt, { now: 1_999_000, live: false });
    // Then both show the frozen 5s
    expect(first).toBe("5s");
    expect(later).toBe("5s");
  });

  test("freezes for terminal status even when finishedAt is missing", () => {
    // Given a done/failed/skipped step without finishedAt (e.g. resume-boot prior steps)
    const startedAt = 1_000_000;
    const frozen = durationSecondsFrom(startedAt, undefined, { now: 1_500_000, live: false });
    // Then it does not tick with now — uses startedAt as end (0s)
    expect(frozen).toBe("0s");
  });

  test("ticks for live running/waiting statuses when finishedAt is absent", () => {
    const startedAt = 1_000_000;
    expect(durationSecondsFrom(startedAt, undefined, { now: 1_010_000, live: true })).toBe("10s");
    expect(durationSecondsFrom(startedAt, undefined, { now: 1_070_000, live: true })).toBe("1m");
  });
});

describe("isLiveStepStatus", () => {
  test("only running and waiting are live", () => {
    expect(isLiveStepStatus("running")).toBe(true);
    expect(isLiveStepStatus("waiting")).toBe(true);
    expect(isLiveStepStatus("done")).toBe(false);
    expect(isLiveStepStatus("failed")).toBe(false);
    expect(isLiveStepStatus("skipped")).toBe(false);
    expect(isLiveStepStatus("pending")).toBe(false);
  });
});

describe("stepListStatusColor / icon for completed steps", () => {
  test("done stays green with a checkmark", () => {
    expect(stepListStatusIcon("done", "⠋")).toBe("✓");
    expect(stepListStatusColor("done")).toBe("#a6e3a1");
  });
});

describe("background agent completed styling", () => {
  test("idle background agents are gray", () => {
    const idle = createBackgroundAgent("ses_idle", 1_000, { activity: "idle", finishedAt: 6_000 });
    const busy = createBackgroundAgent("ses_busy", 1_000, { activity: "busy" });
    expect(backgroundAgentRowColor(idle)).toBe("#6c7086");
    expect(backgroundAgentRowColor(busy)).toBe("#94e2d5");
  });

  test("idle background agent duration freezes at finishedAt", () => {
    const startedAt = 1_000_000;
    const finishedAt = 1_005_000;
    const frozen = durationSecondsFrom(startedAt, finishedAt, { now: 1_999_000, live: false });
    expect(frozen).toBe("5s");
  });
});

describe("complete group collapse", () => {
  test("collapses only direct idle descendants under the step", () => {
    const s = state(["build"]);
    s.steps[0]!.status = "waiting";
    s.steps[0]!.sessionID = "ses_root";
    s.steps[0]!.backgroundAgents = [
      createBackgroundAgent("ses_busy", 1, {
        activity: "busy",
        title: "live",
        depth: 1,
        parentSessionID: "ses_root",
      }),
      createBackgroundAgent("ses_a", 2, {
        activity: "idle",
        title: "a",
        depth: 1,
        parentSessionID: "ses_root",
      }),
      createBackgroundAgent("ses_b", 3, {
        activity: "idle",
        title: "b",
        depth: 1,
        parentSessionID: "ses_root",
      }),
      createBackgroundAgent("ses_a_child", 4, {
        activity: "idle",
        title: "nested",
        depth: 2,
        parentSessionID: "ses_a",
      }),
    ];

    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      { kind: "background", stepIndex: 0, sessionID: "ses_busy" },
      {
        kind: "background-complete",
        stepIndex: 0,
        count: 2,
        parentSessionID: null,
        depth: 1,
      },
    ]);
  });

  test("nested idle children collapse under their parent when that parent is shown", () => {
    const s = state(["build"]);
    s.steps[0]!.sessionID = "ses_root";
    s.steps[0]!.backgroundAgents = [
      createBackgroundAgent("ses_parent", 1, {
        activity: "busy",
        title: "parent",
        depth: 1,
        parentSessionID: "ses_root",
      }),
      createBackgroundAgent("ses_c1", 2, {
        activity: "idle",
        title: "c1",
        depth: 2,
        parentSessionID: "ses_parent",
      }),
      createBackgroundAgent("ses_c2", 3, {
        activity: "idle",
        title: "c2",
        depth: 2,
        parentSessionID: "ses_parent",
      }),
    ];

    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      { kind: "background", stepIndex: 0, sessionID: "ses_parent" },
      {
        kind: "background-complete",
        stepIndex: 0,
        count: 2,
        parentSessionID: "ses_parent",
        depth: 2,
      },
    ]);

    setCompleteGroupExpanded(s, 0, true, "ses_parent");
    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      { kind: "background", stepIndex: 0, sessionID: "ses_parent" },
      {
        kind: "background-complete",
        stepIndex: 0,
        count: 2,
        parentSessionID: "ses_parent",
        depth: 2,
      },
      { kind: "background", stepIndex: 0, sessionID: "ses_c1" },
      { kind: "background", stepIndex: 0, sessionID: "ses_c2" },
    ]);
  });

  test("expands idle agents under the Complete row when toggled", () => {
    const s = state(["build"]);
    s.steps[0]!.backgroundAgents = [
      createBackgroundAgent("ses_a", 2, { activity: "idle", title: "a", depth: 1 }),
      createBackgroundAgent("ses_b", 3, { activity: "idle", title: "b", depth: 1 }),
    ];
    setCompleteGroupExpanded(s, 0, true);

    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      {
        kind: "background-complete",
        stepIndex: 0,
        count: 2,
        parentSessionID: null,
        depth: 1,
      },
      { kind: "background", stepIndex: 0, sessionID: "ses_a" },
      { kind: "background", stepIndex: 0, sessionID: "ses_b" },
    ]);
  });

  test("a single idle agent with no children stays visible (no 1 Complete wrapper)", () => {
    const s = state(["build"]);
    s.steps[0]!.backgroundAgents = [
      createBackgroundAgent("ses_a", 2, { activity: "idle", title: "a", depth: 1 }),
    ];
    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      { kind: "background", stepIndex: 0, sessionID: "ses_a" },
    ]);
  });

  test("a single idle agent with nested children collapses as 1 Complete", () => {
    const s = state(["build"]);
    s.steps[0]!.sessionID = "ses_root";
    s.steps[0]!.backgroundAgents = [
      createBackgroundAgent("ses_a", 2, {
        activity: "idle",
        title: "a",
        depth: 1,
        parentSessionID: "ses_root",
      }),
      createBackgroundAgent("ses_a_child", 3, {
        activity: "idle",
        title: "nested",
        depth: 2,
        parentSessionID: "ses_a",
      }),
    ];
    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      {
        kind: "background-complete",
        stepIndex: 0,
        count: 1,
        parentSessionID: null,
        depth: 1,
      },
    ]);
  });

  test("collapse moves selection from an idle agent onto its Complete group", () => {
    const s = state(["build"]);
    s.steps[0]!.sessionID = "ses_root";
    s.steps[0]!.backgroundAgents = [
      createBackgroundAgent("ses_a", 2, {
        activity: "idle",
        title: "a",
        depth: 1,
        parentSessionID: "ses_root",
      }),
      createBackgroundAgent("ses_b", 3, {
        activity: "idle",
        title: "b",
        depth: 1,
        parentSessionID: "ses_root",
      }),
    ];
    setCompleteGroupExpanded(s, 0, true);
    s.selectedStepIndex = 0;
    s.selectedBackgroundSessionID = "ses_a";
    setCompleteGroupExpanded(s, 0, false);
    expect(s.selectedBackgroundSessionID).toBe(COMPLETE_GROUP_SESSION_ID);
    expect(flattenRows(s)).toEqual([
      { kind: "step", stepIndex: 0 },
      {
        kind: "background-complete",
        stepIndex: 0,
        count: 2,
        parentSessionID: null,
        depth: 1,
      },
    ]);
  });
});
