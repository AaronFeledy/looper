import { describe, expect, test } from "bun:test";

import { watchGithubPr } from "../src/lib/github-watcher.ts";
import type { GithubStatus } from "../src/lib/state.ts";

type Deferred = {
  branch: string;
  resolve: (status: GithubStatus) => void;
  promise: Promise<GithubStatus>;
};

function makeFetchQueue() {
  const calls: Deferred[] = [];
  const fetchStatus = (_repoDir: string, branch: string): Promise<GithubStatus> => {
    let resolve!: (status: GithubStatus) => void;
    const promise = new Promise<GithubStatus>((r) => {
      resolve = r;
    });
    calls.push({ branch, resolve, promise });
    return promise;
  };
  return { calls, fetchStatus };
}

async function flush(): Promise<void> {
  await Bun.sleep(0);
}

describe("watchGithubPr", () => {
  test("publishes the fetched status for the current branch", async () => {
    const { calls, fetchStatus } = makeFetchQueue();
    const updates: GithubStatus[] = [];
    const watcher = watchGithubPr({
      repoDir: ".",
      getBranch: () => "main",
      onUpdate: (status) => updates.push(status),
      pollIntervalMs: 60_000,
      fetchStatus,
    });
    try {
      await flush();
      expect(calls.length).toBe(1);
      calls[0]!.resolve({ kind: "no-pr" });
      await flush();
      expect(updates).toEqual([{ kind: "no-pr" }]);
    } finally {
      watcher.stop();
    }
  });

  test("does not start an overlapping poll; queues the refresh instead", async () => {
    const { calls, fetchStatus } = makeFetchQueue();
    const updates: GithubStatus[] = [];
    const watcher = watchGithubPr({
      repoDir: ".",
      getBranch: () => "main",
      onUpdate: (status) => updates.push(status),
      pollIntervalMs: 60_000,
      fetchStatus,
    });
    try {
      await flush();
      expect(calls.length).toBe(1); // initial poll in flight

      // Refreshes while in flight must not spawn concurrent fetches.
      watcher.refresh();
      watcher.refresh();
      await flush();
      expect(calls.length).toBe(1);

      // Settling the in-flight poll drains exactly one queued refresh.
      calls[0]!.resolve({ kind: "no-pr" });
      await flush();
      expect(calls.length).toBe(2);

      calls[1]!.resolve({ kind: "no-pr" });
      await flush();
      expect(calls.length).toBe(2);
    } finally {
      watcher.stop();
    }
  });

  test("discards a stale-branch result and re-polls for the current branch", async () => {
    const { calls, fetchStatus } = makeFetchQueue();
    const updates: GithubStatus[] = [];
    let branch = "feature-a";
    const watcher = watchGithubPr({
      repoDir: ".",
      getBranch: () => branch,
      onUpdate: (status) => updates.push(status),
      pollIntervalMs: 60_000,
      fetchStatus,
    });
    try {
      await flush();
      expect(calls.length).toBe(1);
      expect(calls[0]!.branch).toBe("feature-a");

      // Branch switches while the feature-a poll is still in flight.
      branch = "feature-b";
      const staleStatus: GithubStatus = { kind: "pr", pr: { number: 1, title: "A", state: "OPEN", isDraft: false, url: "", ciOverall: "passing", ciPassing: 1, ciFailing: 0, ciPending: 0, ciNeutral: 0, ciTotal: 1, mergeable: "mergeable" } };
      calls[0]!.resolve(staleStatus);
      await flush();

      // The stale feature-a result must not be published; a feature-b poll runs.
      expect(updates).toEqual([]);
      expect(calls.length).toBe(2);
      expect(calls[1]!.branch).toBe("feature-b");

      calls[1]!.resolve({ kind: "no-pr" });
      await flush();
      expect(updates).toEqual([{ kind: "no-pr" }]);
    } finally {
      watcher.stop();
    }
  });

  test("does not publish updates after stop()", async () => {
    const { calls, fetchStatus } = makeFetchQueue();
    const updates: GithubStatus[] = [];
    const watcher = watchGithubPr({
      repoDir: ".",
      getBranch: () => "main",
      onUpdate: (status) => updates.push(status),
      pollIntervalMs: 60_000,
      fetchStatus,
    });
    await flush();
    expect(calls.length).toBe(1);

    watcher.stop();
    calls[0]!.resolve({ kind: "no-pr" });
    await flush();
    expect(updates).toEqual([]);

    // refresh() after stop() is a no-op.
    watcher.refresh();
    await flush();
    expect(calls.length).toBe(1);
  });
});
