import { describe, expect, test } from "bun:test";

import { lookupServerVersion } from "../src/lib/server-version.ts";

describe("server version lookup", () => {
  test("returns no version when the health request rejects", async () => {
    const version = await lookupServerVersion(
      async () => Promise.reject(new Error("transport failed")),
      new AbortController().signal,
      10,
    );

    expect(version).toBeUndefined();
  });

  test("returns no version when the health request exceeds its timeout", async () => {
    const version = await lookupServerVersion(
      (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      new AbortController().signal,
      1,
    );

    expect(version).toBeUndefined();
  });

  test("returns no version at the deadline when health ignores cancellation", async () => {
    const version = await lookupServerVersion(
      async () => new Promise(() => {}),
      new AbortController().signal,
      1,
    );

    expect(version).toBeUndefined();
  }, 50);

  test("returns the reported server version", async () => {
    const version = await lookupServerVersion(
      async () => ({ data: { version: "1.2.3" } }),
      new AbortController().signal,
      10,
    );

    expect(version).toBe("1.2.3");
  });

  test("returns no version when health reports an error", async () => {
    const version = await lookupServerVersion(
      async () => ({ error: new Error("unhealthy") }),
      new AbortController().signal,
      10,
    );

    expect(version).toBeUndefined();
  });

  test("returns no version when health reports no data", async () => {
    const version = await lookupServerVersion(
      async () => ({}),
      new AbortController().signal,
      10,
    );

    expect(version).toBeUndefined();
  });

  test("rejects with the parent reason when startup is cancelled", async () => {
    const parent = new AbortController();
    const reason = new Error("startup cancelled");
    const lookup = lookupServerVersion(
      async () => new Promise(() => {}),
      parent.signal,
      10,
    );

    parent.abort(reason);

    const rejection = await lookup.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejection).toBe(reason);
  });
});
