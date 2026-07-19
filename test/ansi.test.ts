import { describe, expect, test } from "bun:test";

import { sanitizeTerminalText } from "../src/lib/ansi.ts";

describe("terminal text sanitization", () => {
  test("removes terminal controls while preserving newlines and tabs", () => {
    const unsafeControls = String.fromCharCode(
      ...Array.from({ length: 32 }, (_, code) => code).filter((code) => code !== 0x09 && code !== 0x0a),
      0x7f,
    );
    const malicious =
      `first\u001b[2J line\rrewritten\n\tsecond\u001b]52;c;secret\u0007\u009b31m safe${unsafeControls}`;

    expect(sanitizeTerminalText(malicious)).toBe("first linerewritten\n\tsecond safe");
  });
});
