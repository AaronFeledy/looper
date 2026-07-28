import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runEngine } from "../src/engine/run-engine.ts";
import { createStallDetector, createStallObserver, materialPathsExist, stallDetectionEnabled, type StallObservation } from "../src/engine/stall-detector.ts";
import { createLoopState } from "../src/lib/state.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createRunStateStore } from "../src/persistence/run-state-store.ts";
import { createInMemoryAdjudicationStore } from "./helpers/adjudication-stub.ts";

function observation(overrides: Partial<StallObservation> = {}): StallObservation {
  return {
    branch: "us-1-story",
    storyId: "US-1",
    headCommit: "abc123",
    hasMaterialChange: false,
    passes: { "US-1": false },
    phase: "building",
    adjudicationCompletions: 0,
    ...overrides,
  };
}

describe("stallDetectionEnabled", () => {
  test("disabled only when both limits are zero", () => {
    expect(stallDetectionEnabled({ iterations: 0, adjudications: 0 })).toBe(false);
    expect(stallDetectionEnabled({ iterations: 3, adjudications: 0 })).toBe(true);
    expect(stallDetectionEnabled({ iterations: 0, adjudications: 3 })).toBe(true);
  });
});

describe("createStallDetector iteration limit", () => {
  test("stalls after K consecutive no-progress iterations", () => {
    const detector = createStallDetector({ limits: { iterations: 3, adjudications: 0 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(false);
    const verdict = detector.observe(observation());

    expect(verdict.stalled).toBe(true);
    if (verdict.stalled) {
      expect(verdict.reason).toContain("3 consecutive iterations");
      expect(verdict.reason).toContain("US-1");
    }
  });

  test("first observation always counts as progress", () => {
    const detector = createStallDetector({ limits: { iterations: 1, adjudications: 0 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(true);
  });

  test.each([
    ["passes change", { passes: { "US-1": true } }],
    ["phase change", { phase: "implemented" }],
    ["branch change", { branch: "us-2-next", storyId: "US-2" }],
  ] as const)("resets the counter on %s", (_label, progressOverrides) => {
    const detector = createStallDetector({ limits: { iterations: 2, adjudications: 0 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation(progressOverrides)).stalled).toBe(false);
    expect(detector.observe(observation(progressOverrides)).stalled).toBe(false);
    expect(detector.observe(observation(progressOverrides)).stalled).toBe(true);
  });

  test("resets the counter on material commits", () => {
    const detector = createStallDetector({ limits: { iterations: 2, adjudications: 0 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation({ hasMaterialChange: true })).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(true);
  });

  test("unknown passes on both sides does not count as progress", () => {
    const detector = createStallDetector({ limits: { iterations: 2, adjudications: 0 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation({ passes: undefined }))).toEqual({ stalled: false });
    expect(detector.observe(observation({ passes: undefined }))).toEqual({ stalled: false });
    expect(detector.observe(observation({ passes: undefined })).stalled).toBe(true);
  });

  test("zero iteration limit disables no-progress detection", () => {
    const detector = createStallDetector({ limits: { iterations: 0, adjudications: 5 }, initialAdjudicationCompletions: 0 });

    for (let index = 0; index < 20; index += 1) {
      expect(detector.observe(observation())).toEqual({ stalled: false });
    }
  });
});

describe("createStallDetector adjudication limit", () => {
  test("stalls when one story accumulates M completed adjudications", () => {
    const detector = createStallDetector({ limits: { iterations: 0, adjudications: 3 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation({ adjudicationCompletions: 1 })).stalled).toBe(false);
    expect(detector.observe(observation({ adjudicationCompletions: 2 })).stalled).toBe(false);
    const verdict = detector.observe(observation({ adjudicationCompletions: 3 }));

    expect(verdict.stalled).toBe(true);
    if (verdict.stalled) expect(verdict.reason).toContain("3 completed adjudications for US-1");
  });

  test("attributes adjudications per story so a new story starts fresh", () => {
    const detector = createStallDetector({ limits: { iterations: 0, adjudications: 2 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation({ adjudicationCompletions: 1 })).stalled).toBe(false);
    expect(detector.observe(observation({ branch: "us-2-next", storyId: "US-2", adjudicationCompletions: 2 })).stalled).toBe(false);
    expect(detector.observe(observation({ branch: "us-2-next", storyId: "US-2", adjudicationCompletions: 3 })).stalled).toBe(true);
  });

  test("pre-run completions in the log never count", () => {
    const detector = createStallDetector({ limits: { iterations: 0, adjudications: 2 }, initialAdjudicationCompletions: 5 });

    expect(detector.observe(observation({ adjudicationCompletions: 5 })).stalled).toBe(false);
    expect(detector.observe(observation({ adjudicationCompletions: 6 })).stalled).toBe(false);
    expect(detector.observe(observation({ adjudicationCompletions: 7 })).stalled).toBe(true);
  });

  test("zero adjudication limit disables the cap", () => {
    const detector = createStallDetector({ limits: { iterations: 0, adjudications: 0 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation({ adjudicationCompletions: 50 }))).toEqual({ stalled: false });
  });
});

describe("materialPathsExist", () => {
  test("classifies paths against the PRD directory", () => {
    expect(materialPathsExist(["spec/progress.txt", "spec/prd.json"], "spec")).toBe(false);
    expect(materialPathsExist(["spec/progress.txt", "core/src/index.ts"], "spec")).toBe(true);
    expect(materialPathsExist([], "spec")).toBe(false);
    expect(materialPathsExist(["anything.txt"], undefined)).toBe(true);
    expect(materialPathsExist(["specification.md"], "spec")).toBe(true);
  });
});

describe("createStallObserver against a real git repo", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function gitScratch(): Promise<string> {
    const repoDir = mkdtempSync(join(tmpdir(), "looper-stall-"));
    scratchDirs.push(repoDir);
    await $`git init -q -b main`.cwd(repoDir).quiet();
    mkdirSync(join(repoDir, "spec"), { recursive: true });
    writeFileSync(join(repoDir, "spec", "progress.txt"), "log\n");
    writeFileSync(join(repoDir, "tracked.txt"), "base\n");
    await $`git add -A`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m init`.cwd(repoDir).quiet();
    return repoDir;
  }

  async function commit(repoDir: string, relPath: string, message: string): Promise<void> {
    writeFileSync(join(repoDir, relPath), `${message}\n`);
    await $`git add -A`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m ${message}`.cwd(repoDir).quiet();
  }

  test("stalls on idle iterations, ignores PRD-only commits, resets on production commits", async () => {
    const repoDir = await gitScratch();
    const observer = createStallObserver({
      repoDir,
      limits: { iterations: 2, adjudications: 0 },
      prdDir: join(repoDir, "spec"),
      readCompletionsCount: () => 0,
      readPasses: () => ({ "US-1": false }),
    });

    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    await commit(repoDir, join("spec", "progress.txt"), "docs-churn");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    await commit(repoDir, "tracked.txt", "production-change");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    await commit(repoDir, join("spec", "progress.txt"), "more-docs-churn");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    const verdict = await observer.checkIteration("us-1-story");

    expect(verdict.stalled).toBe(true);
    if (verdict.stalled) expect(verdict.reason).toContain("no material progress on US-1");
  });

  test("fails open when the repo is not a git repository", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "looper-stall-nogit-"));
    scratchDirs.push(repoDir);
    const observer = createStallObserver({
      repoDir,
      limits: { iterations: 1, adjudications: 0 },
      readCompletionsCount: () => 0,
    });

    expect(await observer.checkIteration("main")).toEqual({ stalled: false });
    expect(await observer.checkIteration("main")).toEqual({ stalled: false });
  });
});

describe("runEngine stall integration", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("an idle loop stops with a stall reason and writes the stop file", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "looper-stall-engine-"));
    scratchDirs.push(repoDir);
    await $`git init -q -b main`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "tracked.txt"), "base\n");
    await $`git add -A`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m init`.cwd(repoDir).quiet();
    const configDir = join(repoDir, ".looper");
    mkdirSync(configDir, { recursive: true });
    initStatePaths({ configDir });
    const runStateStore = createRunStateStore({ configDir });
    runStateStore.clearStopFiles();

    const result = await runEngine({
      fresh: true,
      maxIterations: 10,
      waitProvided: false,
      waitDuration: 0,
      repoDir,
      configDir,
      client: {},
      store: runStateStore,
      hooks: { createIterationState: () => createLoopState({ maxIterations: 10, stepNames: ["Step1"] }) },
      loadSteps: () => [{ name: "Step1", prompt: join(configDir, "step1.md") }],
      currentBranch: async () => "main",
      createLooperRunID: () => "run-stall",
      legacyResumeStepIndex: () => 0,
      runIteration: async () => "complete",
      adjudication: { store: createInMemoryAdjudicationStore(), threshold: 2 },
      stall: { iterations: 2, adjudications: 3 },
    });

    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toContain("stall detected");
    expect(existsSync(join(configDir, ".looper-stop"))).toBe(true);
  });
});
