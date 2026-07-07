import { describe, expect, test } from "bun:test";

import { acquireRelease } from "../src/platform/acquire-release.ts";

type ReleaseRecord<R> = {
  readonly resource: R;
  readonly outcome: { readonly ok: boolean; readonly error?: unknown };
};

describe("acquireRelease", () => {
  test("returns the use result and releases once with ok true", async () => {
    // Given: a resource that can be acquired, used, and released.
    const releases: ReleaseRecord<string>[] = [];

    // When: the use path succeeds.
    const result = await acquireRelease(
      async () => "session-1",
      async (resource) => `title from ${resource}`,
      (resource, outcome) => {
        releases.push({ resource, outcome });
      },
    );

    // Then: the use result is returned and release observes a successful outcome exactly once.
    expect(result).toBe("title from session-1");
    expect(releases).toHaveLength(1);
    expect(releases[0]).toEqual({ resource: "session-1", outcome: { ok: true } });
  });

  test("releases once with ok false and rethrows the original use error", async () => {
    // Given: a use path that fails after acquiring the resource.
    const useError = new Error("use failed");
    const releases: ReleaseRecord<string>[] = [];

    // When: the use path rejects.
    const run = acquireRelease(
      async () => "session-2",
      async () => {
        throw useError;
      },
      (resource, outcome) => {
        releases.push({ resource, outcome });
      },
    );

    // Then: release observes the failure exactly once and the original use error propagates.
    expect(await run.catch((error: unknown) => error)).toBe(useError);
    expect(releases).toHaveLength(1);
    expect(releases[0]?.resource).toBe("session-2");
    expect(releases[0]?.outcome.ok).toBe(false);
    expect(releases[0]?.outcome.error).toBe(useError);
  });

  test("does not release when acquire throws", async () => {
    // Given: acquisition fails before any resource exists.
    const acquireError = new Error("acquire failed");
    let releaseCalls = 0;

    // When: acquire rejects.
    const run = acquireRelease(
      async () => {
        throw acquireError;
      },
      async () => "unused",
      () => {
        releaseCalls += 1;
      },
    );

    // Then: the acquire error propagates and release is never called.
    expect(await run.catch((error: unknown) => error)).toBe(acquireError);
    expect(releaseCalls).toBe(0);
  });

  test("swallows a release error after successful use and reports it", async () => {
    // Given: release fails after the use path succeeds.
    const releaseError = new Error("release failed");
    const observedReleaseErrors: unknown[] = [];

    // When: release throws after success.
    const result = await acquireRelease(
      async () => "session-3",
      async () => "generated title",
      () => {
        throw releaseError;
      },
      {
        onReleaseError: (error) => {
          observedReleaseErrors.push(error);
        },
      },
    );

    // Then: the successful use result is preserved and the release error is observable.
    expect(result).toBe("generated title");
    expect(observedReleaseErrors).toEqual([releaseError]);
  });

  test("swallows a release error after failed use and rethrows the original use error", async () => {
    // Given: both use and release fail.
    const useError = new Error("use failed first");
    const releaseError = new Error("release failed second");
    const observedReleaseErrors: unknown[] = [];

    // When: release throws while cleaning up the failed use path.
    const run = acquireRelease(
      async () => "session-4",
      async () => {
        throw useError;
      },
      () => {
        throw releaseError;
      },
      {
        onReleaseError: (error) => {
          observedReleaseErrors.push(error);
        },
      },
    );

    // Then: the use error is not masked by release, and release failure is reported.
    expect(await run.catch((error: unknown) => error)).toBe(useError);
    expect(observedReleaseErrors).toEqual([releaseError]);
  });

  test("releases exactly once when use throws synchronously", async () => {
    // Given: a use callback that throws before returning a promise.
    const useError = new Error("sync use failed");
    let releaseCalls = 0;

    // When: use throws synchronously.
    const run = acquireRelease(
      async () => "session-5",
      () => {
        throw useError;
      },
      (_resource, outcome) => {
        releaseCalls += 1;
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toBe(useError);
      },
    );

    // Then: release still runs once and the original synchronous use error propagates.
    expect(await run.catch((error: unknown) => error)).toBe(useError);
    expect(releaseCalls).toBe(1);
  });
});
