import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import {
  findControlFlagAccesses,
  findModuleLoads,
  listSourceFiles,
} from "./helpers/architecture-boundary.ts";

const OPENCODE_DIR = join(import.meta.dir, "../src/opencode");
const ENGINE_DIR = join(import.meta.dir, "../src/engine");

/** Catches the LoopState identifier */
const LOOP_STATE_RE = /\bLoopState\b/;
const FORBIDDEN_OPENCODE_MODULE_RE = /^(?:\.\.\/)+lib\/(state|agent-tree-state)\.ts$/;

type Offense = {
  readonly file: string;
  readonly line: number;
  readonly message: string;
};

function relFromSrc(absPath: string): string {
  const marker = "/src/";
  const idx = absPath.lastIndexOf(marker);
  if (idx === -1) return absPath;
  return absPath.slice(idx + 1);
}

function findMatches(source: string, re: RegExp): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Reset lastIndex for global-safe reuse; patterns here are non-global.
    re.lastIndex = 0;
    if (re.test(lines[i]!)) hits.push(i + 1);
  }
  return hits;
}

function collectOpencodeBoundaryOffenses(dir: string = OPENCODE_DIR): Offense[] {
  const offenses: Offense[] = [];
  for (const abs of listSourceFiles(dir)) {
    const rel = relFromSrc(abs);
    const source = readFileSync(abs, "utf8");

    for (const load of findModuleLoads(source, abs)) {
      if (load.specifier === undefined) {
        offenses.push({
          file: rel,
          line: load.line,
          message: `${rel}:${load.line} uses a non-static module load that cannot be boundary-checked`,
        });
      } else if (FORBIDDEN_OPENCODE_MODULE_RE.test(load.specifier)) {
        offenses.push({
          file: rel,
          line: load.line,
          message: `${rel}:${load.line} loads ${load.specifier}`,
        });
      }
    }
    for (const line of findMatches(source, LOOP_STATE_RE)) {
      offenses.push({
        file: rel,
        line,
        message: `${rel}:${line} references LoopState`,
      });
    }
  }
  return offenses;
}

function collectControlFlagOffenses(): Offense[] {
  const offenses: Offense[] = [];
  for (const dir of [OPENCODE_DIR, ENGINE_DIR]) {
    for (const abs of listSourceFiles(dir)) {
      const rel = relFromSrc(abs);
      const source = readFileSync(abs, "utf8");
      for (const access of findControlFlagAccesses(source, abs)) {
        offenses.push({
          file: rel,
          line: access.line,
          message: `${rel}:${access.line} reads/writes state control flag ${access.flag}`,
        });
      }
    }
  }
  return offenses;
}

describe("architecture guards", () => {
  test("src/opencode must not import state.ts, reference LoopState, or import agent-tree-state.ts", () => {
    // A scan that silently found no files would pass vacuously.
    expect(listSourceFiles(OPENCODE_DIR)).toContain(join(OPENCODE_DIR, "step-runner.ts"));
    const offenses = collectOpencodeBoundaryOffenses();
    expect(offenses.map((o) => o.message)).toEqual([]);
  });

  test("src/opencode and src/engine must not touch control flags on state", () => {
    expect(listSourceFiles(ENGINE_DIR)).toContain(join(ENGINE_DIR, "run-control.ts"));
    const offenses = collectControlFlagOffenses();
    expect(offenses.map((o) => o.message)).toEqual([]);
  });
});

describe("architecture guard self-test", () => {
  test("module-load parser resolves static, dynamic, CommonJS, re-export, and computed loads", () => {
    const source = `
      import { notify } from "../lib/state.ts";
      import type { LoopState } from '../../lib/state.ts';
      import legacyState = require("../lib/state.ts");
      export { setStepContinuation } from /* wrapped */ "../lib/agent-tree-state.ts";
      await import /* wrapped */ (
        "../lib/" + "state.ts"
      );
      require(\`../lib/agent-tree-state.ts\`);
      const load = require;
      load("../lib/state.ts");
      module.require("../lib/agent-tree-state.ts");
      module["require"]("../lib/state.ts");
      require.main.require("../lib/state.ts");
      const { require: destructuredLoad } = module;
      destructuredLoad("../lib/agent-tree-state.ts");
      const parenthesizedLoad = (require);
      parenthesizedLoad("../lib/state.ts");
      let assignedLoad;
      assignedLoad = require;
      assignedLoad("../lib/state.ts");
      unrelated.require("../lib/state.ts");
      import { stopFileExists } from "../lib/state-files.ts";
    `;

    expect(findModuleLoads(source, "fixture.ts").map(({ specifier }) => specifier)).toEqual([
      "../lib/state.ts",
      "../../lib/state.ts",
      "../lib/state.ts",
      "../lib/agent-tree-state.ts",
      "../lib/state.ts",
      "../lib/agent-tree-state.ts",
      "../lib/state.ts",
      "../lib/agent-tree-state.ts",
      "../lib/state.ts",
      "../lib/state.ts",
      "../lib/agent-tree-state.ts",
      "../lib/state.ts",
      "../lib/state.ts",
      "../lib/state-files.ts",
    ]);
  });

  test("module-load parser marks variable dynamic loads as unresolved", () => {
    expect(findModuleLoads(`await import(modulePath);`, "fixture.ts")).toEqual([
      { line: 1, specifier: undefined },
    ]);
  });

  test("LOOP_STATE_RE matches the LoopState identifier", () => {
    expect(LOOP_STATE_RE.test("type LoopState = {")).toBe(true);
    expect(LOOP_STATE_RE.test("state: LoopState;")).toBe(true);
    expect(LOOP_STATE_RE.test("LoopStateful")).toBe(false);
  });

  test("listSourceFiles scans supported source extensions in nested directories", () => {
    const root = mkdtempSync(join(tmpdir(), "looper-architecture-guard-"));
    try {
      const nested = join(root, "nested");
      mkdirSync(nested);
      const topLevelFile = join(root, "top-level.ts");
      const nestedMtsFile = join(nested, "nested.mts");
      const nestedJsFile = join(nested, "nested.js");
      writeFileSync(topLevelFile, "export {};\n");
      writeFileSync(nestedMtsFile, "export {};\n");
      writeFileSync(nestedJsFile, "export {};\n");
      writeFileSync(join(nested, "ignored.md"), "ignored\n");

      expect(listSourceFiles(root)).toEqual([nestedJsFile, nestedMtsFile, topLevelFile]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("boundary collector rejects wrapped and unresolved module loads", () => {
    const root = mkdtempSync(join(tmpdir(), "looper-architecture-guard-"));
    try {
      writeFileSync(
        join(root, "wrapped.mts"),
        `export { notify } from /* wrapped */ "../lib/state.ts";\n`,
      );
      writeFileSync(join(root, "dynamic.js"), `await import(modulePath);\n`);

      expect(
        collectOpencodeBoundaryOffenses(root).map(({ message }) => message.replace(`${root}/`, "")),
      ).toEqual([
        "dynamic.js:1 uses a non-static module load that cannot be boundary-checked",
        "wrapped.mts:1 loads ../lib/state.ts",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("control flag scanner follows direct, bracket, alias, and destructured state access", () => {
    // Given: the six LoopState control flags
    const flagNames = [
      "quitting",
      "paused",
      "skipRequested",
      "restartRequested",
      "restartReason",
      "stopAfterIteration",
    ] as const;
    const source = flagNames.flatMap((name) => [
      `state.${name};`,
      `state.control.${name};`,
      `state["control"]["${name}"];`,
    ]).join("\n") + `
      const controlAlias = state.control;
      controlAlias.quitting;
      const { paused } = state;
      const { control } = state;
      control.restartRequested;
      const { control: { quitting } } = state;
      let assignedState;
      assignedState = (state);
      assignedState.control.quitting;
      ctx.control.stopAfterIteration;
    `;

    // When/Then: direct, bracket, alias, and destructured state accesses are found.
    const accesses = findControlFlagAccesses(source, "fixture.ts");
    for (const name of flagNames) {
      const extra = name === "quitting" ? 3 : name === "paused" || name === "restartRequested" ? 1 : 0;
      expect(accesses.filter(({ flag }) => flag === name)).toHaveLength(3 + extra);
    }
    // Then: a RunStepContext control access is allowed.
    expect(accesses).toHaveLength(23);
  });
});
