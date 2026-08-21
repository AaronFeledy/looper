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

  test("ellipsizes wide stars within target width", () => {
    const result = truncateDisplay("⭐⭐⭐", 4);
    expect(result.endsWith("…")).toBe(true);
    expect(displayWidth(result)).toBeLessThanOrEqual(4);
  });
});

describe("displayWidth current table", () => {
  test("ascii / cjk / star / zwj family-of-3 / ansi abc", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("你好")).toBe(4);
    expect(displayWidth("⭐")).toBe(2);
    expect(displayWidth("👨‍👩‍👧")).toBe(2);
    expect(displayWidth("\u001b[31mabc\u001b[0m")).toBe(3);
    expect(displayWidth("hello")).toBe(Bun.stringWidth("hello"));
    expect(displayWidth("你好")).toBe(Bun.stringWidth("你好"));
    expect(displayWidth("⭐")).toBe(Bun.stringWidth("⭐"));
    expect(displayWidth("👨‍👩‍👧")).toBe(Bun.stringWidth("👨‍👩‍👧"));
    expect(displayWidth("\u001b[31mabc\u001b[0m")).toBe(Bun.stringWidth("\u001b[31mabc\u001b[0m"));
  });
});

describe("Bun.stringWidth intended pins", () => {
  test("pins the accepted Bun improvements", () => {
    expect(Bun.stringWidth("hello")).toBe(5);
    expect(Bun.stringWidth("你好")).toBe(4);
    expect(Bun.stringWidth("⭐")).toBe(2);
    expect(Bun.stringWidth("👨‍👩‍👧")).toBe(2);
    expect(Bun.stringWidth("\u001b[31mabc\u001b[0m")).toBe(3);
  });
});
