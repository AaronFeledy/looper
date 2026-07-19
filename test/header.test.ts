import { TextRenderable } from "@opentui/core";
import { RGBA } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, test } from "bun:test";

import { createLoopState } from "../src/lib/state.ts";
import { buildServerBadge, createHeader, SERVER_BADGE_ID } from "../src/tui/header.ts";

function headerLine(frame: string): string {
  const line = frame.split("\n").find((candidate) => candidate.includes("OpenCode"));
  if (line === undefined) throw new Error("expected a header line containing the badge");
  return line;
}

describe("buildServerBadge", () => {
  test("dims only the label and leaves the green dot bright and uncolored elsewhere", () => {
    const badge = buildServerBadge("1.2.3");
    const chunks = badge.chunks;

    expect(chunks[0]?.text).toBe("●");
    expect(chunks[0]?.fg).toBeDefined();
    // The green dot must stay bright: it keeps its color and gains no DIM attribute.
    expect((chunks[0]?.attributes ?? 0) & TextAttributes.DIM).toBe(0);

    expect(chunks.map((chunk) => chunk.text).join("")).toBe("● OpenCode v1.2.3");

    const labelChunks = chunks.slice(1);
    expect(labelChunks.length).toBeGreaterThan(0);
    for (const chunk of labelChunks) {
      expect(chunk.fg).toBeUndefined();
      expect((chunk.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
    }
  });

  test("normalizes the green dot to the shared palette green", () => {
    const badge = buildServerBadge("9.9.9");
    const color = badge.chunks[0]?.fg;
    expect(color).toBeInstanceOf(RGBA);
    if (!(color instanceof RGBA)) throw new Error("expected a parsed dot color");
    // #a6e3a1 -> rgb(166, 227, 161): green is the dominant, near-max channel.
    expect(color.g).toBeGreaterThan(color.r);
    expect(color.g).toBeGreaterThan(color.b);
    expect(Math.round(color.r * 255)).toBe(166);
    expect(Math.round(color.g * 255)).toBe(227);
    expect(Math.round(color.b * 255)).toBe(161);
  });
});

describe("createHeader server badge", () => {
  test("renders the left content and right-aligned badge at wide width", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 6 });
    const state = createLoopState({ maxIterations: 3, stepNames: ["Build"] });
    state.branch = "main";

    renderer.root.add(createHeader(renderer, state, "1.2.3"));
    await renderOnce();

    const line = headerLine(captureCharFrame());
    expect(line).toContain("Looper · waiting to start");
    expect(line).toContain("branch main");
    const trimmed = line.trimEnd();
    expect(trimmed.endsWith("● OpenCode v1.2.3")).toBe(true);
    // Badge is inset by exactly one terminal column: its last glyph lands one
    // column before the viewport's right edge, leaving a single blank column.
    expect(trimmed.length).toBe(79);
    expect(line[78]).toBe("3");
    expect(line[79]).toBe(" ");
    // Badge is in the right portion of the line, after the left content.
    expect(line.indexOf("OpenCode")).toBeGreaterThan(40);
    renderer.destroy();
  });

  test("renders the active Looper label once the loop has started", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 6 });
    const state = createLoopState({ maxIterations: 3, stepNames: ["Build"] });
    state.branch = "main";
    state.started = true;
    state.iteration = 2;
    state.iterationStartedAt = Date.now();

    renderer.root.add(createHeader(renderer, state, "1.2.3"));
    await renderOnce();

    const line = headerLine(captureCharFrame());
    expect(line).toContain("Looper · iteration 2/3");
    expect(line).not.toContain("waiting to start");
    renderer.destroy();
  });

  test("keeps the badge intact and truncates the left label at narrow width", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 30, height: 6 });
    const state = createLoopState({ maxIterations: 3, stepNames: ["Build"] });
    state.branch = "main";

    renderer.root.add(createHeader(renderer, state, "1.2.3"));
    await renderOnce();

    const line = headerLine(captureCharFrame());
    // Full badge survives even though the row is narrow.
    expect(line).toContain("● OpenCode v1.2.3");
    expect(line.trimEnd().endsWith("● OpenCode v1.2.3")).toBe(true);
    expect(line[28]).toBe("3");
    expect(line[29]).toBe(" ");
    // Left label is truncated: the untruncated waiting label would exceed the row.
    expect(line).not.toContain("waiting to start");
    renderer.destroy();
  });

  test("omits the badge when no server version is available", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 80, height: 6 });
    const state = createLoopState({ maxIterations: 3, stepNames: ["Build"] });

    const header = createHeader(renderer, state, undefined);
    renderer.root.add(header);
    await renderOnce();

    expect(header.findDescendantById(SERVER_BADGE_ID)).toBeUndefined();
    const frame = captureCharFrame();
    expect(frame).not.toContain("OpenCode v");
    renderer.destroy();
  });

  test("mounts the badge as a text renderable with the stable id", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 6 });
    const state = createLoopState({ maxIterations: 3, stepNames: ["Build"] });

    const header = createHeader(renderer, state, "1.2.3");
    renderer.root.add(header);
    await renderOnce();

    const badge = header.findDescendantById(SERVER_BADGE_ID);
    expect(badge).toBeInstanceOf(TextRenderable);
    renderer.destroy();
  });
});
