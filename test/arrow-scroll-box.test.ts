import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { ArrowScrollBoxRenderable } from "../src/tui/arrow-scroll-box.ts";

for (const border of [false, true]) test(`overflow arrows track wheel, programmatic scroll, resize, and shrinking content (${border ? "border" : "hint rows"})`, async () => {
  const setup = await createTestRenderer({width: 40, height: 18});
  const pane = new ArrowScrollBoxRenderable(setup.renderer, {
    id: "pane", width: 28, height: 8, border, scrollY: true, scrollX: false,
    contentOptions: {width: "100%", minHeight: "auto"},
  });
  const text = new TextRenderable(setup.renderer, {id: "body", width: "100%", content: Array.from({length: 24}, (_, i) => `row ${i}`).join("\n")});
  pane.add(text); setup.renderer.root.add(pane);
  const arrows = () => {
    const lines = setup.captureCharFrame().split("\n");
    const x = pane.x + Math.floor((pane.width - 1) / 2);
    return [lines[pane.y]![x], lines[pane.y + pane.height - 1]![x]];
  };
  try {
    await setup.flush();
    expect(arrows()[0]).not.toBe("▲"); expect(arrows()[1]).toBe("▼");
    expect(pane.verticalScrollBar.visible).toBe(false);
    expect(pane.horizontalScrollBar.visible).toBe(false);
    await setup.mockMouse.scroll(pane.x + 4, pane.y + 3, "down", {delayMs: 0});
    await setup.flush();
    expect(arrows()).toEqual(["▲", "▼"]);
    pane.scrollTop = 999;
    await setup.flush();
    expect(arrows()[0]).toBe("▲"); expect(arrows()[1]).not.toBe("▼");
    pane.height = 5;
    await setup.flush();
    expect(arrows()[1]).toBe("▼");
    text.content = "one row";
    pane.scrollTop = 0;
    await setup.flush();
    expect(arrows()[0]).not.toBe("▲"); expect(arrows()[1]).not.toBe("▼");
    text.content = Array.from({length: 24}, (_, i) => `new row ${i}`).join("\n");
    await setup.flush();
    expect(arrows()[1]).toBe("▼");
    expect(pane.verticalScrollBar.visible).toBe(false);
    expect(pane.viewport.y).toBeGreaterThan(pane.y);
    expect(pane.viewport.y + pane.viewport.height).toBeLessThan(pane.y + pane.height);
    if (!border) expect(pane.viewport.width).toBe(pane.width);
  } finally { setup.renderer.destroy(); }
});
