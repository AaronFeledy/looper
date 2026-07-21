import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { evaluateGate, runGateScript, type GateInputs } from "../src/engine/step-gate.ts";

type GateCase = {
  readonly name: string;
  readonly inputs: GateInputs;
  readonly expected: ReturnType<typeof evaluateGate>;
};

const GATE_CASES: readonly GateCase[] = [
  {
    name: "passes when no conditions are configured",
    inputs: { gate: {}, branch: undefined, storyId: undefined, passes: undefined, phase: undefined },
    expected: { pass: true },
  },
  {
    name: "passes a story branch condition when a story id is derivable",
    inputs: { gate: { branch: "story" }, branch: "us-074-work", storyId: "US-074", passes: undefined, phase: undefined },
    expected: { pass: true },
  },
  {
    name: "fails a story branch condition when the story id is underivable",
    inputs: { gate: { branch: "story" }, branch: "feature-work", storyId: undefined, passes: undefined, phase: undefined },
    expected: { pass: false, reason: "gate: branch is not a story branch" },
  },
  {
    name: "fails a story branch condition when git has no branch",
    inputs: { gate: { branch: "story" }, branch: undefined, storyId: undefined, passes: undefined, phase: undefined },
    expected: { pass: false, reason: "gate: branch is not a story branch" },
  },
  {
    name: "passes a main branch condition only on main",
    inputs: { gate: { branch: "main" }, branch: "main", storyId: undefined, passes: undefined, phase: undefined },
    expected: { pass: true },
  },
  {
    name: "fails a main branch condition on a story branch",
    inputs: { gate: { branch: "main" }, branch: "us-074-work", storyId: "US-074", passes: undefined, phase: undefined },
    expected: { pass: false, reason: "gate: branch is not main" },
  },
  {
    name: "fails a main branch condition when git has no branch",
    inputs: { gate: { branch: "main" }, branch: undefined, storyId: undefined, passes: undefined, phase: undefined },
    expected: { pass: false, reason: "gate: branch is not main" },
  },
  {
    name: "passes prdPasses only when passes is exactly true",
    inputs: { gate: { prdPasses: true }, branch: "us-074-work", storyId: "US-074", passes: true, phase: undefined },
    expected: { pass: true },
  },
  {
    name: "fails prdPasses when the story is false",
    inputs: { gate: { prdPasses: true }, branch: "us-074-work", storyId: "US-074", passes: false, phase: undefined },
    expected: { pass: false, reason: "gate: prdPasses is false for US-074" },
  },
  {
    name: "fails prdPasses when the story or prd snapshot is missing",
    inputs: { gate: { prdPasses: true }, branch: "us-074-work", storyId: "US-074", passes: undefined, phase: undefined },
    expected: { pass: false, reason: "gate: prdPasses is unavailable for US-074" },
  },
  {
    name: "fails prdPasses when a story id is underivable",
    inputs: { gate: { prdPasses: true }, branch: "feature-work", storyId: undefined, passes: undefined, phase: undefined },
    expected: { pass: false, reason: "gate: prdPasses requires a story id" },
  },
  {
    name: "treats a missing phase as building",
    inputs: { gate: { phase: "building" }, branch: "us-074-work", storyId: "US-074", passes: undefined, phase: undefined },
    expected: { pass: true },
  },
  {
    name: "passes when the current phase equals the required phase",
    inputs: { gate: { phase: "verified" }, branch: "us-074-work", storyId: "US-074", passes: undefined, phase: "verified" },
    expected: { pass: true },
  },
  {
    name: "passes when the current phase is beyond the required phase",
    inputs: { gate: { phase: "reviewed" }, branch: "us-074-work", storyId: "US-074", passes: undefined, phase: "merged" },
    expected: { pass: true },
  },
  {
    name: "fails when the current phase is before the required phase",
    inputs: { gate: { phase: "verified" }, branch: "us-074-work", storyId: "US-074", passes: undefined, phase: "reviewed" },
    expected: { pass: false, reason: "gate: phase reviewed is before verified" },
  },
  {
    name: "passes a script condition on exit zero",
    inputs: { gate: { script: "true" }, branch: undefined, storyId: undefined, passes: undefined, phase: undefined, scriptResult: { ran: true, exitCode: 0 } },
    expected: { pass: true },
  },
  {
    name: "fails a script condition on nonzero exit",
    inputs: { gate: { script: "false" }, branch: undefined, storyId: undefined, passes: undefined, phase: undefined, scriptResult: { ran: true, exitCode: 7 } },
    expected: { pass: false, reason: "gate: script exited with code 7" },
  },
  {
    name: "fails loudly when a script times out or cannot spawn",
    inputs: { gate: { script: "sleep 10" }, branch: undefined, storyId: undefined, passes: undefined, phase: undefined, scriptResult: { ran: false, error: "timed out after 25ms" } },
    expected: { pass: false, reason: "gate: script failed: timed out after 25ms" },
  },
  {
    name: "fails closed when a configured script has no result",
    inputs: { gate: { script: "true" }, branch: undefined, storyId: undefined, passes: undefined, phase: undefined },
    expected: { pass: false, reason: "gate: script did not run" },
  },
  {
    name: "AND-combines configured conditions and names the first failure",
    inputs: { gate: { branch: "story", prdPasses: true, phase: "verified", script: "true" }, branch: "main", storyId: undefined, passes: false, phase: "building", scriptResult: { ran: true, exitCode: 0 } },
    expected: { pass: false, reason: "gate: branch is not a story branch" },
  },
];

describe("evaluateGate", () => {
  for (const testCase of GATE_CASES) {
    test(testCase.name, () => {
      // Given already-derived facts and a parsed gate configuration.
      const { inputs } = testCase;

      // When the pure gate decision is evaluated.
      const actual = evaluateGate(inputs);

      // Then the configured conditions are AND-combined with an explicit reason.
      expect(actual).toEqual(testCase.expected);
    });
  }
});

const scratchDirs: string[] = [];
const originalInheritedValue = process.env["LOOPER_GATE_TEST_INHERITED"];
const originalBranchValue = process.env["LOOPER_BRANCH"];
const originalStoryIdValue = process.env["LOOPER_STORY_ID"];
const originalPrdDirValue = process.env["LOOPER_PRD_DIR"];
const originalPrdIndexValue = process.env["LOOPER_PRD_INDEX"];
const originalPrdProgressValue = process.env["LOOPER_PRD_PROGRESS"];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createScratchDir(): string {
  const root = join(import.meta.dir, ".tmp");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "step-gate-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  restoreEnv("LOOPER_GATE_TEST_INHERITED", originalInheritedValue);
  restoreEnv("LOOPER_BRANCH", originalBranchValue);
  restoreEnv("LOOPER_STORY_ID", originalStoryIdValue);
  restoreEnv("LOOPER_PRD_DIR", originalPrdDirValue);
  restoreEnv("LOOPER_PRD_INDEX", originalPrdIndexValue);
  restoreEnv("LOOPER_PRD_PROGRESS", originalPrdProgressValue);
});

describe("runGateScript", () => {
  test("inherits the environment and overrides both documented story facts", async () => {
    // Given an inherited variable and conflicting process-level LOOPER values.
    const repoDir = createScratchDir();
    const output = join(repoDir, "env.txt");
    process.env["LOOPER_GATE_TEST_INHERITED"] = "inherited";
    process.env["LOOPER_BRANCH"] = "stale-branch";
    process.env["LOOPER_STORY_ID"] = "STALE-001";

    // When a gate script receives the caller-derived branch and story id.
    const result = await runGateScript(
      `printf '%s' "$LOOPER_GATE_TEST_INHERITED|$LOOPER_BRANCH|$LOOPER_STORY_ID" > ${JSON.stringify(output)}`,
      { repoDir, branch: "us-074-work", storyId: "US-074", timeoutMs: 1_000 },
    );

    // Then inherited values remain visible and both documented values are overlaid.
    expect(result).toEqual({ ran: true, exitCode: 0 });
    expect(readFileSync(output, "utf8")).toBe("inherited|us-074-work|US-074");
  });

  test("exports caller-derived PRD display paths", async () => {
    // Given conflicting inherited PRD path values.
    const repoDir = createScratchDir();
    const output = join(repoDir, "prd-env.txt");
    process.env["LOOPER_PRD_DIR"] = "stale-dir";
    process.env["LOOPER_PRD_INDEX"] = "stale-index";
    process.env["LOOPER_PRD_PROGRESS"] = "stale-progress";

    // When a gate script receives caller-derived display paths.
    const result = await runGateScript(
      `printf '%s' "$LOOPER_PRD_DIR|$LOOPER_PRD_INDEX|$LOOPER_PRD_PROGRESS" > ${JSON.stringify(output)}`,
      {
        repoDir,
        prdDir: "product/prd",
        prdIndex: "product/prd/prd.json",
        prdProgress: "product/prd/progress.txt",
        timeoutMs: 1_000,
      },
    );

    // Then all PRD values are overlaid.
    expect(result).toEqual({ ran: true, exitCode: 0 });
    expect(readFileSync(output, "utf8")).toBe("product/prd|product/prd/prd.json|product/prd/progress.txt");
  });

  test("exports empty story facts when the caller cannot derive them", async () => {
    // Given no caller-derived branch or story id.
    const repoDir = createScratchDir();
    const output = join(repoDir, "empty-env.txt");

    // When the script records the documented environment values.
    const result = await runGateScript(
      `printf '%s' "$LOOPER_BRANCH|$LOOPER_STORY_ID|$LOOPER_PRD_DIR|$LOOPER_PRD_INDEX|$LOOPER_PRD_PROGRESS" > ${JSON.stringify(output)}`,
      { repoDir, timeoutMs: 1_000 },
    );

    // Then all documented values are present as empty strings.
    expect(result).toEqual({ ran: true, exitCode: 0 });
    expect(readFileSync(output, "utf8")).toBe("||||");
  });

  test("kills the detached process group before a timed-out script can write later", async () => {
    // Given a script whose delayed write occurs well after the timeout.
    const repoDir = createScratchDir();
    const sentinel = join(repoDir, "late-sentinel.txt");

    // When the detached script group exceeds its deadline.
    const result = await runGateScript(
      `sleep 0.2; printf 'late' > ${JSON.stringify(sentinel)}`,
      { repoDir, timeoutMs: 25 },
    );

    // Then the timeout is loud, and waiting beyond the intended write proves no descendant survived.
    expect(result.ran).toBe(false);
    expect(result.error).toContain("timed out after 25ms");
    await Bun.sleep(300);
    expect(existsSync(sentinel)).toBe(false);
  });
});
