import { expect, test } from "bun:test";

import { createBackgroundAgent, createStepRow } from "../src/lib/state.ts";
import { agentRowLabel, continuationIndicatorText, MAX_DISPLAY_DEPTH } from "../src/presentation/tui/agent-rows.ts";
import { formatRow } from "../src/tui/step-list.ts";

const ROW_WIDTH = 24;

test("agentRowLabel has no leading indentation when depth is one", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0, { depth: 1, title: "worker" });

  // When
  const label = agentRowLabel(agent, "⠋");

  // Then
  expect(label).toBe("↳ ⠋ worker");
});

test("agentRowLabel indents by two spaces when depth is two", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0, { depth: 2, title: "worker" });

  // When
  const label = agentRowLabel(agent, "⠋");

  // Then
  expect(label).toBe("  ↳ ⠋ worker");
});

test("agentRowLabel indents by four spaces when depth is three", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0, { depth: 3, title: "worker" });

  // When
  const label = agentRowLabel(agent, "⠋");

  // Then
  expect(label).toBe("    ↳ ⠋ worker");
});

test("agentRowLabel clamps deep agents to the maximum display depth", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0, { depth: 7, title: "worker" });

  // When
  const label = agentRowLabel(agent, "⠋");

  // Then
  expect(MAX_DISPLAY_DEPTH).toBe(3);
  expect(label).toBe("    ↳ ⠋ worker");
});

test("agentRowLabel uses the spinner frame when activity is busy", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0, { activity: "busy", title: "worker" });

  // When
  const label = agentRowLabel(agent, "⠹");

  // Then
  expect(label).toBe("↳ ⠹ worker");
});

test("agentRowLabel treats missing activity as busy", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0, { title: "worker" });

  // When
  const label = agentRowLabel(agent, "⠸");

  // Then
  expect(label).toBe("↳ ⠸ worker");
});

test("agentRowLabel uses a checkmark when activity is idle", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0, { activity: "idle", title: "worker" });

  // When
  const label = agentRowLabel(agent, "⠋");

  // Then
  expect(label).toBe("↳ ✓ worker");
});

test("agentRowLabel prefers the title over the agent name", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0, { agent: "explore", title: "Search code" });

  // When
  const label = agentRowLabel(agent, "⠋");

  // Then
  expect(label).toBe("↳ ⠋ Search code");
});

test("agentRowLabel falls back to the agent name", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0, { agent: "explore" });

  // When
  const label = agentRowLabel(agent, "⠋");

  // Then
  expect(label).toBe("↳ ⠋ explore");
});

test("agentRowLabel falls back to the session suffix", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0);

  // When
  const label = agentRowLabel(agent, "⠋");

  // Then
  expect(label).toBe("↳ ⠋ 123456");
});

test("agentRowLabel composes with formatRow within the content width", () => {
  // Given
  const agent = createBackgroundAgent("ses_123456", 0, {
    depth: 3,
    title: "a very long background agent title that overflows",
  });

  // When
  const row = formatRow(agentRowLabel(agent, "⠋"), "12m");

  // Then
  expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
  expect(row.endsWith("12m")).toBe(true);
});

test("continuationIndicatorText is empty when continuation is unset", () => {
  // Given
  const step = createStepRow("build");

  // When
  const indicator = continuationIndicatorText(step);

  // Then
  expect(indicator).toBe("");
});

test("continuationIndicatorText returns a bounded non-empty indicator", () => {
  // Given
  const step = createStepRow("build");
  step.continuation = { reason: "waiting for background tasks to finish", since: 0 };

  // When
  const indicator = continuationIndicatorText(step);

  // Then
  expect(indicator.length).toBeGreaterThan(0);
  expect(indicator.length).toBeLessThanOrEqual(12);
  expect(indicator.endsWith("…")).toBe(true);
});
