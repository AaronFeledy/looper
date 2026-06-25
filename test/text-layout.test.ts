import { describe, expect, test } from "bun:test";

import { displayWidth, truncateDisplay, wrapDisplayLines } from "../src/tui/text-layout.ts";

describe("wrapDisplayLines", () => {
  test("returns single line when text fits", () => {
    expect(wrapDisplayLines("hello world", 20, 2)).toEqual(["hello world"]);
  });

  test("ellipsizes last line when exceeding maxLines", () => {
    const lines = wrapDisplayLines("one two three four five six seven", 10, 2);
    expect(lines.length).toBe(2);
    expect(displayWidth(lines[1]!)).toBeLessThanOrEqual(10);
  });
});

describe("truncateDisplay", () => {
  test("appends ellipsis when over width", () => {
    const result = truncateDisplay("abcdefghij", 6);
    expect(result.endsWith("…")).toBe(true);
    expect(displayWidth(result)).toBeLessThanOrEqual(6);
  });
});
