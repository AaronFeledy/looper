import { describe, expect, test } from "bun:test";

import type { LooperEvent } from "../../src/core/events.ts";
import type { PendingPermission, PendingQuestion } from "../../src/core/pending-request.ts";
import type { StepRowView } from "../../src/core/step-view.ts";
import type { StepReporter } from "../../src/engine/step-reporter.ts";

type ReporterFixture = {
  readonly reporter: StepReporter;
  readonly readRow: (stepIndex: number) => StepRowView | undefined;
  readonly readStepLines: (stepIndex: number) => readonly string[];
  readonly readStepEvents: (stepIndex: number) => readonly LooperEvent[];
  readonly readAgentLines: () => readonly string[];
};

const permission: PendingPermission = {
  requestID: "permission-1",
  sessionID: "session-1",
  permission: "edit",
  patterns: ["src/**"],
  generation: 1,
};

const question: PendingQuestion = {
  requestID: "question-1",
  sessionID: "session-1",
  questions: [{ prompt: "Continue?" }],
  generation: 1,
};

export function runStepReporterContract(name: string, factory: () => ReporterFixture): void {
  describe(name, () => {
    test("begins a running row when a step starts", () => {
      // Given
      const { reporter, readRow } = factory();

      // When
      reporter.steps.begin(0);

      // Then
      const row = readRow(0);
      expect(row?.status).toBe("running");
      expect(row?.startedAt).toBeNumber();
      expect(row?.finishedAt).toBeUndefined();
    });

    test("marks a running row as waiting", () => {
      // Given
      const { reporter, readRow } = factory();
      reporter.steps.begin(0, { statusMessage: "working" });

      // When
      reporter.steps.markWaiting(0);

      // Then
      expect(readRow(0)).toMatchObject({ status: "waiting", statusMessage: undefined });
    });

    test("clears terminal time when waiting for background work", () => {
      // Given
      const { reporter, readRow } = factory();
      reporter.steps.finalize(0, "done");

      // When
      reporter.steps.markWaitingForBackground(0);

      // Then
      expect(readRow(0)?.status).toBe("waiting");
      expect(readRow(0)?.finishedAt).toBeUndefined();
    });

    test("finalizes a completed row", () => {
      // Given
      const { reporter, readRow } = factory();
      reporter.steps.begin(0);

      // When
      reporter.steps.finalize(0, "done");

      // Then
      expect(readRow(0)?.status).toBe("done");
      expect(readRow(0)?.finishedAt).toBeNumber();
    });

    test("resets a restarted row to pending", () => {
      // Given
      const { reporter, readRow } = factory();
      reporter.steps.begin(0, { statusMessage: "running" });

      // When
      reporter.steps.finalize(0, "restart", { statusMessage: "ignored" });

      // Then
      expect(readRow(0)?.status).toBe("pending");
      expect(readRow(0)?.statusMessage).toBeUndefined();
      expect(readRow(0)?.finishedAt).toBeUndefined();
    });

    test("exposes step metadata through the row view", () => {
      // Given
      const { reporter } = factory();

      // When
      reporter.steps.setSessionID(0, "session-2");
      reporter.steps.setPromptText(0, "prompt");
      reporter.steps.setLooperMessageIDs(0, ["message-1", "message-2"]);

      // Then
      const row = reporter.steps.get(0);
      expect(row?.sessionID).toBe("session-2");
      expect(row?.looperMessageIDs).toEqual(["message-1", "message-2"]);
      expect(row !== undefined && "promptText" in row ? row.promptText : undefined).toBe("prompt");
    });

    test("appends a line to agent and step buffers", () => {
      // Given
      const { reporter, readAgentLines, readStepLines } = factory();

      // When
      reporter.out.line(0, "hello", 10);

      // Then
      expect(readAgentLines()).toEqual(["hello"]);
      expect(readStepLines(0)).toEqual(["hello"]);
    });

    test("converts prefixed looper lines into step events", () => {
      // Given
      const { reporter, readStepEvents } = factory();

      // When
      reporter.out.line(0, "[looper] resumed", 10);

      // Then
      expect(readStepEvents(0)).toEqual([{ kind: "looper.log", message: "resumed" }]);
    });

    test("appends events without adding lines", () => {
      // Given
      const { reporter, readAgentLines, readStepEvents, readStepLines } = factory();
      const event: LooperEvent = { kind: "assistant.started" };

      // When
      reporter.out.event(0, event, 10);

      // Then
      expect(readStepEvents(0)).toEqual([event]);
      expect(readAgentLines()).toEqual([]);
      expect(readStepLines(0)).toEqual([]);
    });

    test("returns undefined for an out-of-range row", () => {
      // Given
      const { reporter } = factory();

      // When
      const row = reporter.steps.get(999);

      // Then
      expect(row).toBeUndefined();
    });

    test("ignores out-of-range lifecycle writes", () => {
      // Given
      const { reporter } = factory();

      // When
      const act = (): void => {
        reporter.steps.begin(999);
        reporter.steps.markWaiting(999);
        reporter.steps.markWaitingForBackground(999);
        reporter.steps.finalize(999, "done");
        reporter.steps.setSessionID(999, "session");
        reporter.steps.setPromptText(999, "prompt");
        reporter.steps.setLooperMessageIDs(999, []);
        reporter.steps.setContinuation(999, { reason: "background", since: 10 });
        reporter.steps.clearStatusMessageIf(999, "status");
      };

      // Then
      expect(act).not.toThrow();
    });

    test("preserves a status message that does not match", () => {
      // Given
      const { reporter, readRow } = factory();
      reporter.steps.begin(0, { statusMessage: "reattaching" });

      // When
      reporter.steps.clearStatusMessageIf(0, "other");

      // Then
      expect(readRow(0)?.statusMessage).toBe("reattaching");
    });

    test("clears a status message that matches exactly", () => {
      // Given
      const { reporter, readRow } = factory();
      reporter.steps.begin(0, { statusMessage: "reattaching" });

      // When
      reporter.steps.clearStatusMessageIf(0, "reattaching");

      // Then
      expect(readRow(0)?.statusMessage).toBeUndefined();
    });

    test("lists permission and question requests", () => {
      // Given
      const { reporter } = factory();

      // When
      reporter.requests.enqueuePermission(permission);
      reporter.requests.enqueueQuestion(question);

      // Then
      expect(reporter.requests.list().map(({ kind }) => kind)).toEqual(["permission", "question"]);
    });

    test("consumes a resolving request decision", () => {
      // Given
      const { reporter } = factory();
      reporter.requests.enqueuePermission(permission);
      const request = reporter.requests.list()[0];
      if (request !== undefined) {
        request.status = "resolving";
        request.decision = "once";
      }

      // When
      const decision = reporter.requests.consumeDecision(permission);

      // Then
      expect(decision).toBe("once");
    });

    test("reads the current request list after clearing all requests", () => {
      // Given
      const { reporter } = factory();
      reporter.requests.enqueuePermission(permission);
      const before = reporter.requests.list();

      // When
      reporter.requests.clearAll();

      // Then
      expect(before).toHaveLength(1);
      expect(reporter.requests.list()).toEqual([]);
    });

    test("accepts todo updates", () => {
      // Given
      const { reporter } = factory();

      // When
      const act = (): void => reporter.requests.setTodos([{ content: "Check", status: "pending", priority: "high" }]);

      // Then
      expect(act).not.toThrow();
    });
  });
}
