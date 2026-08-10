import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const OPENCODE_DIR = join(import.meta.dir, "../src/opencode");
const ENGINE_DIR = join(import.meta.dir, "../src/engine");

/** Catches runtime and `import type` of lib/state.ts at any nesting depth */
const STATE_IMPORT_RE = /from\s+["'](?:\.\.\/)+lib\/state\.ts["']/;
/** Catches the LoopState identifier */
const LOOP_STATE_RE = /\bLoopState\b/;
/** Catches imports of lib/agent-tree-state.ts at any nesting depth */
const AGENT_TREE_STATE_IMPORT_RE = /from\s+["'](?:\.\.\/)+lib\/agent-tree-state\.ts["']/;
/** Control flags that must move behind RunControl */
const CONTROL_FLAG_RE =
  /\bstate\.(?:control\.)?(quitting|paused|skipRequested|restartRequested|restartReason|stopAfterIteration)\b/;

type Offense = {
  readonly file: string;
  readonly line: number;
  readonly message: string;
};

/** Recursive so a future `src/opencode/<subdir>/` cannot slip past the guard. */
function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTsFiles(abs));
    else if (entry.name.endsWith(".ts")) files.push(abs);
  }
  return files.sort();
}

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

function collectOpencodeBoundaryOffenses(): Offense[] {
  const offenses: Offense[] = [];
  for (const abs of listTsFiles(OPENCODE_DIR)) {
    const rel = relFromSrc(abs);
    const source = readFileSync(abs, "utf8");

    for (const line of findMatches(source, STATE_IMPORT_RE)) {
      offenses.push({
        file: rel,
        line,
        message: `${rel}:${line} imports lib/state.ts`,
      });
    }
    for (const line of findMatches(source, LOOP_STATE_RE)) {
      offenses.push({
        file: rel,
        line,
        message: `${rel}:${line} references LoopState`,
      });
    }
    for (const line of findMatches(source, AGENT_TREE_STATE_IMPORT_RE)) {
      offenses.push({
        file: rel,
        line,
        message: `${rel}:${line} imports lib/agent-tree-state.ts`,
      });
    }
  }
  return offenses;
}

function collectControlFlagOffenses(): Offense[] {
  const offenses: Offense[] = [];
  for (const dir of [OPENCODE_DIR, ENGINE_DIR]) {
    for (const abs of listTsFiles(dir)) {
      const rel = relFromSrc(abs);
      const source = readFileSync(abs, "utf8");
      for (const line of findMatches(source, CONTROL_FLAG_RE)) {
        offenses.push({
          file: rel,
          line,
          message: `${rel}:${line} reads/writes a control flag on state`,
        });
      }
    }
  }
  return offenses;
}

describe("architecture guards", () => {
  test("src/opencode must not import state.ts, reference LoopState, or import agent-tree-state.ts", () => {
    // A scan that silently found no files would pass vacuously.
    expect(listTsFiles(OPENCODE_DIR)).toContain(join(OPENCODE_DIR, "step-runner.ts"));
    const offenses = collectOpencodeBoundaryOffenses();
    expect(offenses.map((o) => o.message)).toEqual([]);
  });

  test("src/opencode and src/engine must not touch control flags on state", () => {
    expect(listTsFiles(ENGINE_DIR)).toContain(join(ENGINE_DIR, "run-control.ts"));
    const offenses = collectControlFlagOffenses();
    expect(offenses.map((o) => o.message)).toEqual([]);
  });
});

describe("architecture guard self-test", () => {
  test("STATE_IMPORT_RE matches runtime and type imports of ../lib/state.ts", () => {
    expect(STATE_IMPORT_RE.test(`import { notify } from "../lib/state.ts";`)).toBe(true);
    expect(STATE_IMPORT_RE.test(`import type { LoopState } from "../lib/state.ts";`)).toBe(true);
    expect(STATE_IMPORT_RE.test(`import { notify } from "../../lib/state.ts";`)).toBe(true);
    expect(STATE_IMPORT_RE.test(`import type { LoopState } from '../lib/state.ts';`)).toBe(true);
    expect(STATE_IMPORT_RE.test(`import { stopFileExists } from "../lib/state-files.ts";`)).toBe(false);
  });

  test("LOOP_STATE_RE matches the LoopState identifier", () => {
    expect(LOOP_STATE_RE.test("type LoopState = {")).toBe(true);
    expect(LOOP_STATE_RE.test("state: LoopState;")).toBe(true);
    expect(LOOP_STATE_RE.test("LoopStateful")).toBe(false);
  });

  test("AGENT_TREE_STATE_IMPORT_RE matches agent-tree-state imports", () => {
    expect(
      AGENT_TREE_STATE_IMPORT_RE.test(`import { setStepContinuation } from "../lib/agent-tree-state.ts";`),
    ).toBe(true);
    expect(
      AGENT_TREE_STATE_IMPORT_RE.test(`import { setStepContinuation } from "../../lib/agent-tree-state.ts";`),
    ).toBe(true);
    expect(
      AGENT_TREE_STATE_IMPORT_RE.test(`import { setStepContinuation } from '../lib/agent-tree-state.ts';`),
    ).toBe(true);
    expect(AGENT_TREE_STATE_IMPORT_RE.test(`import { notify } from "../lib/state.ts";`)).toBe(false);
  });

  test("listTsFiles scans nested directories", () => {
    const root = mkdtempSync(join(tmpdir(), "looper-architecture-guard-"));
    try {
      const nested = join(root, "nested");
      mkdirSync(nested);
      const topLevelFile = join(root, "top-level.ts");
      const nestedFile = join(nested, "nested.ts");
      writeFileSync(topLevelFile, "export {};\n");
      writeFileSync(nestedFile, "export {};\n");
      writeFileSync(join(nested, "ignored.md"), "ignored\n");

      expect(listTsFiles(root)).toEqual([nestedFile, topLevelFile]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("CONTROL_FLAG_RE matches each control flag accessor", () => {
    // Given: the six LoopState control flags
    const flagNames = [
      "quitting",
      "paused",
      "skipRequested",
      "restartRequested",
      "restartReason",
      "stopAfterIteration",
    ] as const;
    // When/Then: direct state.<flag> and nested state.control.<flag> both match
    for (const name of flagNames) {
      expect(CONTROL_FLAG_RE.test(`state.${name}`)).toBe(true);
      expect(CONTROL_FLAG_RE.test(`state.control.${name}`)).toBe(true);
    }
    // Then: unrelated properties and non-state identifiers do not match
    expect(CONTROL_FLAG_RE.test("state.steps")).toBe(false);
    expect(CONTROL_FLAG_RE.test("state.control.steps")).toBe(false);
    expect(CONTROL_FLAG_RE.test("myState.quitting")).toBe(false);
  });
});
