import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_PERMISSION_GATE_MAX_MS,
  DEFAULT_PERMISSION_TEARDOWN_MS,
  permissionGateMaxMs,
  permissionTeardownMs,
} from "../src/config/tunables.ts";

const KEYS = ["LOOPER_PERMISSION_GATE_MAX_MS", "LOOPER_PERMISSION_TEARDOWN_MS"] as const;
const original = new Map<string, string | undefined>();
for (const key of KEYS) original.set(key, process.env[key]);

afterEach(() => {
  for (const key of KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("permission timeout tunables", () => {
  test("uses the finite gate and teardown defaults", () => {
    // Given
    delete process.env.LOOPER_PERMISSION_GATE_MAX_MS;
    delete process.env.LOOPER_PERMISSION_TEARDOWN_MS;

    // When / Then
    expect(permissionGateMaxMs()).toBe(DEFAULT_PERMISSION_GATE_MAX_MS);
    expect(permissionTeardownMs()).toBe(DEFAULT_PERMISSION_TEARDOWN_MS);
  });

  test("rejects a gate maximum below one", () => {
    // Given
    process.env.LOOPER_PERMISSION_GATE_MAX_MS = "0";

    // When / Then
    expect(permissionGateMaxMs).toThrow("LOOPER_PERMISSION_GATE_MAX_MS must be an integer greater than or equal to 1");
  });
});
