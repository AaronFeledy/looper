import { describe, expect, test } from "bun:test";

import { copySelectionIfAny, handleSelectionCopyClick } from "../src/tui/selection-copy.ts";

function fakeCopyHost(selectedText: string): {
  host: {
    getSelection: () => { getSelectedText: () => string } | null;
    copyToClipboardOSC52: (text: string) => boolean;
    clearSelection: () => void;
  };
  copied: string[];
  clearedCount: () => number;
} {
  const copied: string[] = [];
  let cleared = 0;
  return {
    host: {
      getSelection: () => (selectedText.length > 0 ? { getSelectedText: () => selectedText } : null),
      copyToClipboardOSC52: (text: string) => {
        copied.push(text);
        return true;
      },
      clearSelection: () => {
        cleared += 1;
      },
    },
    copied,
    clearedCount: () => cleared,
  };
}

function click(button: number): { event: { button: number; preventDefault(): void; stopPropagation(): void }; prevented: number; stopped: number } {
  let prevented = 0;
  let stopped = 0;
  return {
    event: {
      button,
      preventDefault: () => {
        prevented += 1;
      },
      stopPropagation: () => {
        stopped += 1;
      },
    },
    get prevented() {
      return prevented;
    },
    get stopped() {
      return stopped;
    },
  };
}

describe("copySelectionIfAny", () => {
  test("copies and clears when text is selected", () => {
    const fake = fakeCopyHost("hello world");

    const copied = copySelectionIfAny(fake.host);

    expect(copied).toBe(true);
    expect(fake.copied).toEqual(["hello world"]);
    expect(fake.clearedCount()).toBe(1);
  });

  test("is a no-op when nothing is selected", () => {
    const fake = fakeCopyHost("");

    const copied = copySelectionIfAny(fake.host);

    expect(copied).toBe(false);
    expect(fake.copied).toEqual([]);
    expect(fake.clearedCount()).toBe(0);
  });
});

describe("handleSelectionCopyClick", () => {
  test("with a selection, right-click copies the text and clears the highlight", () => {
    const fake = fakeCopyHost("selected line");
    const mouse = click(2);

    handleSelectionCopyClick(fake.host, mouse.event);

    expect(fake.copied).toEqual(["selected line"]);
    expect(fake.clearedCount()).toBe(1);
    expect(mouse.prevented).toBe(1);
    expect(mouse.stopped).toBe(1);
  });

  test("with no selection, right-click does not copy", () => {
    const fake = fakeCopyHost("");
    const mouse = click(2);

    handleSelectionCopyClick(fake.host, mouse.event);

    expect(fake.copied).toEqual([]);
    expect(fake.clearedCount()).toBe(0);
    expect(mouse.prevented).toBe(0);
    expect(mouse.stopped).toBe(0);
  });

  test("left-click does not copy a selection", () => {
    const fake = fakeCopyHost("keep me");
    const mouse = click(0);

    handleSelectionCopyClick(fake.host, mouse.event);

    expect(fake.copied).toEqual([]);
    expect(fake.clearedCount()).toBe(0);
    expect(mouse.prevented).toBe(0);
  });
});
