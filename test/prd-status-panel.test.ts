import { describe, expect, test } from "bun:test";

import type { PrdStatus } from "../src/lib/state.ts";
import { buildPrdPanelLines } from "../src/tui/prd-status.ts";
import { displayWidth } from "../src/tui/text-layout.ts";

describe("buildPrdPanelLines", () => {
  const partial: PrdStatus = { kind: "ok", remaining: 13, total: 41 };

  test("formats ok status without an always-on gain marker", () => {
    const lines = buildPrdPanelLines(partial, 0, 40);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.content).toContain("28/41");
    expect(lines[0]!.content).toContain("13 left");
    expect(lines[0]!.content).not.toContain("✓");
    expect(lines[0]!.content).not.toContain("⚠");
  });

  test("adds a subtle green check only for gain one", () => {
    const line = buildPrdPanelLines(partial, 1, 40)[0]!;

    expect(line.content).toContain("✓");
    expect(line.fg).toBe("#cdd6f4");
    expect(line.styledContent).toBeDefined();
    expect(line.styledContent?.chunks.at(-1)?.text).toBe("✓");
    expect(line.styledContent?.chunks.at(-1)?.fg).toBeDefined();
  });

  test("flags anomalous multi-story gain in red", () => {
    const line = buildPrdPanelLines(partial, 3, 40)[0]!;

    expect(line.content).toContain("⚠+3");
    expect(line.fg).toBe("#f38ba8");
    expect(line.styledContent).toBeUndefined();
  });

  test("colors all-passing status green", () => {
    const line = buildPrdPanelLines({ kind: "ok", remaining: 0, total: 41 }, 0, 40)[0]!;

    expect(line.content).toContain("41/41");
    expect(line.content).toContain("all passing");
    expect(line.fg).toBe("#a6e3a1");
  });

  test("keeps error lines red and width-safe", () => {
    const line = buildPrdPanelLines({ kind: "error", message: "prd.json not found with a very long path" }, 0, 18)[0]!;

    expect(line.content).toStartWith("✗ ");
    expect(line.content).toEndWith("…");
    expect(line.fg).toBe("#f38ba8");
    expect(displayWidth(line.content)).toBeLessThanOrEqual(18);
  });

  test("keeps long ok rows within max width", () => {
    const line = buildPrdPanelLines({ kind: "ok", remaining: 9999, total: 10000 }, 12, 16)[0]!;

    expect(line.content).toContain("⚠+12");
    expect(displayWidth(line.content)).toBeLessThanOrEqual(16);
  });
});
