import { afterEach, describe, expect, test } from "bun:test";

import { cancelPendingNotify, createLoopState } from "../src/lib/state.ts";
import { createWatcherEventHandler } from "../src/tui/watcher-events.ts";

afterEach(() => {
  cancelPendingNotify();
});

function makeHandler() {
  const state = createLoopState({ maxIterations: 1, stepNames: ["a"] });
  let githubRefreshes = 0;
  let branchDiffRefreshes = 0;
  const handle = createWatcherEventHandler({
    state,
    refreshGithub: () => {
      githubRefreshes += 1;
    },
    refreshBranchDiff: () => {
      branchDiffRefreshes += 1;
    },
  });
  return { state, handle, counts: () => ({ githubRefreshes, branchDiffRefreshes }) };
}

describe("createWatcherEventHandler", () => {
  test("branch-change updates branch and refreshes github + branch-diff", () => {
    const { state, handle, counts } = makeHandler();
    state.branch = "main";

    handle({ kind: "branch-change", branch: "feature" });

    expect(state.branch).toBe("feature");
    expect(counts()).toEqual({ githubRefreshes: 1, branchDiffRefreshes: 1 });
  });

  test("branch-change to the same branch is a no-op", () => {
    const { state, handle, counts } = makeHandler();
    state.branch = "feature";

    handle({ kind: "branch-change", branch: "feature" });

    expect(counts()).toEqual({ githubRefreshes: 0, branchDiffRefreshes: 0 });
  });

  test("branch-diff event stores the status", () => {
    const { state, handle } = makeHandler();

    handle({ kind: "branch-diff", status: { kind: "ok", additions: 5, deletions: 2, files: 3 } });

    expect(state.branchDiff).toEqual({ kind: "ok", additions: 5, deletions: 2, files: 3 });
  });

  test("branch-diff hidden collapses the panel state", () => {
    const { state, handle } = makeHandler();
    handle({ kind: "branch-diff", status: { kind: "ok", additions: 1, deletions: 0, files: 1 } });

    handle({ kind: "branch-diff", status: { kind: "hidden" } });

    expect(state.branchDiff).toEqual({ kind: "hidden" });
  });
});
