import { expect, test } from "bun:test";
import { runStallCheck } from "../src/engine/stall-quiescence.ts";

test.each(["settle", "branch", "confirm"] as const)("honors in-memory quit during %s", async (stage) => {
  // Given a stalled observer and no filesystem stop signal.
  let quitting = false;
  let branches = 0;
  let confirmations = 0;
  const writes: string[] = [];
  // When quit arrives at an asynchronous stall-check boundary.
  const result = await runStallCheck({
    confirmMs: 0,
    shouldAbort: () => quitting,
    currentBranch: async () => {
      if (++branches === 2 && stage === "branch") quitting = true;
      return "main";
    },
    observer: {
      checkIteration: async () => {
        if (stage === "settle") quitting = true;
        return { stalled: true, reason: "stall" };
      },
      confirmStall: async () => {
        confirmations += 1;
        if (stage === "confirm") quitting = true;
        return true;
      },
    },
    store: { stopFileExists: () => false, stopAfterIterationFileExists: () => false, stopReason: () => "quit", writeStop: (reason) => { writes.push(reason); } },
  });
  // Then quit wins without writing a stall marker or entering unnecessary confirmation.
  expect(result).toEqual({ stopped: true, reason: "quit" });
  expect(writes).toEqual([]);
  expect(confirmations).toBe(stage === "confirm" ? 1 : 0);
});
