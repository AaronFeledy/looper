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
    expect(opts.init).toBe(true);
  });

  test("init combines with --config-dir", () => {
    const opts = parseArgs(["init", "--config-dir=.local/looper"]);
    expect(opts.init).toBe(true);
    expect(opts.configDir).toBe(".local/looper");
  });

  test("init is off by default", () => {
    expect(parseArgs([]).init).toBe(false);
  });
});
