import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { AgentBubbleRenderable, activityRing, borderChase } from "../src/tui/agent-bubble.ts";

test("activity ring stays bold while pulsing color, and freezes with reduced motion", () => {
  expect(activityRing(0, true)).toEqual({ glyph: "◎", glow: 0, bold: true });
  expect(activityRing(Math.PI / 2, true).glyph).toBe("◎");
  expect(activityRing(Math.PI, true)).toEqual({ glyph: "◎", glow: 1, bold: true });
  expect(activityRing(3 * Math.PI / 2, true).glyph).toBe("◎");
  expect(activityRing(0, false).bold).toBe(true);
  for (let i = 0; i < 20; i++) {
    expect(activityRing(i, true).glyph).toBe("◎");
    expect(activityRing(i, true).bold).toBe(true);
    expect(activityRing(i, false)).toEqual(activityRing(0, false));
  }
});

test("border highlight travels clockwise and leaves a softer wake", () => {
  expect(borderChase(0.25, Math.PI / 2)).toBe(1);
  expect(borderChase(0.20, Math.PI / 2)).toBeGreaterThan(borderChase(0.30, Math.PI / 2));
  expect(borderChase(0.50, Math.PI)).toBe(1);
  expect(borderChase(0, 0)).toBe(borderChase(1, 0));
});

test("native chase changes edge colors while preserving fill, badge, and border geometry", async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  const bubble = new AgentBubbleRenderable(setup.renderer, {
    width: 34, height: 5, border: true, borderStyle: "rounded",
    backgroundColor: "#232137", borderColor: "#9983b7",
    bottomTitle: " needs you ", bottomTitleAlignment: "right",
  });
  setup.renderer.root.add(bubble);
  const dim = [111, 96, 145] as const, bright = [215, 195, 255] as const;
  const colors = () => setup.captureSpans().lines.map(line => line.spans.flatMap(span =>
    Array.from({length: span.width}, () => ({ fg: span.fg.toInts(), bg: span.bg.toInts() }))));
  try {
    bubble.setChase({phase: 0, dim, bright});
    await setup.flush();
    const before = colors(), chars = setup.captureCharFrame();
    bubble.setChase({phase: Math.PI, dim, bright});
    await setup.flush();
    const after = colors();
    expect(setup.captureCharFrame()).toBe(chars);
    expect(chars).toContain("needs you");
    expect(before[0]![0]!.fg).not.toEqual(after[0]![0]!.fg);
    expect(before[1]![1]!.bg).toEqual(after[1]![1]!.bg);
    expect(after[1]![1]!.bg.slice(0, 3)).toEqual([35, 33, 55]);
    bubble.setChase(undefined);
    await setup.flush();
    const still = colors();
    expect(still[0]![0]!.fg).toEqual(still[0]![15]!.fg);
  } finally { setup.renderer.destroy(); }
});
