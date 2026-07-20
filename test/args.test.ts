import { describe, expect, test } from "bun:test";

import { HelpRequested, parseArgs } from "../src/lib/args.ts";

describe("parseArgs resume flags", () => {
  test("defaults: not started, not fresh (resume is the default)", () => {
    const opts = parseArgs([]);
    expect(opts.start).toBe(false);
    expect(opts.fresh).toBe(false);
  });

  test("--start begins immediately and still resumes (not fresh)", () => {
    const opts = parseArgs(["--start"]);
    expect(opts.start).toBe(true);
    expect(opts.fresh).toBe(false);
  });

  test("--fresh sets fresh without implying start", () => {
    const opts = parseArgs(["--fresh"]);
    expect(opts.fresh).toBe(true);
    expect(opts.start).toBe(false);
  });

  test("--fresh --start combine", () => {
    const opts = parseArgs(["--fresh", "--start"]);
    expect(opts.fresh).toBe(true);
    expect(opts.start).toBe(true);
  });

  test("--continue is a deprecated alias of --start (starts, not fresh)", () => {
    const opts = parseArgs(["--continue"]);
    expect(opts.start).toBe(true);
    expect(opts.fresh).toBe(false);
  });

  test("--help throws HelpRequested whose message documents --fresh", () => {
    expect(() => parseArgs(["--help"])).toThrow(HelpRequested);
    try {
      parseArgs(["--help"]);
    } catch (error) {
      expect(error).toBeInstanceOf(HelpRequested);
      expect((error as HelpRequested).message).toContain("--fresh");
    }
  });
});

describe("parseArgs init command", () => {
  test("init positional enables init mode", () => {
    const opts = parseArgs(["init"]);
    expect(opts.command).toEqual({ kind: "init" });
  });

  test("init combines with --config-dir after the command", () => {
    const opts = parseArgs(["init", "--config-dir=.local/looper"]);
    expect(opts.command).toEqual({ kind: "init" });
    expect(opts.configDir).toBe(".local/looper");
  });

  test("init combines with flags before the command", () => {
    const opts = parseArgs(["--config-dir", ".local/looper", "--start", "init"]);
    expect(opts.command).toEqual({ kind: "init" });
    expect(opts.configDir).toBe(".local/looper");
    expect(opts.start).toBe(true);
  });

  test("init combines with flags after the command", () => {
    const opts = parseArgs(["init", "--start", "5"]);
    expect(opts.command).toEqual({ kind: "init" });
    expect(opts.start).toBe(true);
    expect(opts.maxIterations).toBe(5);
  });

  test("run is the default command", () => {
    expect(parseArgs([]).command).toEqual({ kind: "run" });
  });
});

describe("parseArgs existing run grammar", () => {
  test("bare numeric positional sets max iterations", () => {
    expect(parseArgs(["5"]).maxIterations).toBe(5);
  });

  test("--start before a bare numeric preserves both values", () => {
    const opts = parseArgs(["--start", "5"]);
    expect(opts.start).toBe(true);
    expect(opts.maxIterations).toBe(5);
  });
});

describe("parseArgs signal command", () => {
  test.each([
    ["adjudicate", { kind: "adjudicate", reason: "requirements conflict" }],
    ["stop", { kind: "stop", reason: "operator request" }],
    ["stop-after-iteration", { kind: "stop-after-iteration", reason: "maintenance" }],
  ] as const)("parses signal %s with a reason", (kind, signal) => {
    const opts = parseArgs(["signal", kind, "--reason", signal.reason]);
    expect(opts.command).toEqual({ kind: "signal", signal });
  });

  test("parses story phase with an explicit story", () => {
    const opts = parseArgs(["signal", "story-phase", "merged", "--story", "US-999"]);
    expect(opts.command).toEqual({ kind: "signal", signal: { kind: "story-phase", phase: "merged", story: "US-999" } });
  });

  test("parses story phase without an explicit story", () => {
    const opts = parseArgs(["signal", "story-phase", "reviewed"]);
    expect(opts.command).toEqual({ kind: "signal", signal: { kind: "story-phase", phase: "reviewed" } });
  });

  test("accepts --config-dir before signal", () => {
    const opts = parseArgs(["--config-dir", ".local/looper", "signal", "stop", "--reason", "done"]);
    expect(opts.configDir).toBe(".local/looper");
    expect(opts.command).toEqual({ kind: "signal", signal: { kind: "stop", reason: "done" } });
  });

  test("accepts --config-dir after signal", () => {
    const opts = parseArgs(["signal", "stop", "--config-dir=.local/looper", "--reason=done"]);
    expect(opts.configDir).toBe(".local/looper");
    expect(opts.command).toEqual({ kind: "signal", signal: { kind: "stop", reason: "done" } });
  });

  test.each([
    ["missing signal kind", ["signal"]],
    ["unknown signal kind", ["signal", "bogus"]],
    ["missing reason", ["signal", "stop"]],
    ["empty reason", ["signal", "stop", "--reason="]],
    ["missing story phase", ["signal", "story-phase"]],
    ["invalid story phase", ["signal", "story-phase", "shipping"]],
    ["missing story id", ["signal", "story-phase", "merged", "--story"]],
    ["multiple commands", ["init", "signal", "stop", "--reason", "done"]],
    ["repeated command", ["init", "init"]],
    ["numeric loop positional", ["signal", "stop", "5", "--reason", "done"]],
    ["start loop flag", ["signal", "stop", "--start", "--reason", "done"]],
    ["fresh loop flag", ["signal", "stop", "--fresh", "--reason", "done"]],
    ["wait loop flag", ["signal", "stop", "--wait", "--reason", "done"]],
    ["attach loop flag", ["signal", "stop", "--attach", "--reason", "done"]],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});
