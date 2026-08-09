import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runEngine } from "../src/engine/run-engine.ts";
import { createStallDetector, createStallObserver, materialPathsExist, stallDetectionEnabled, type StallObservation } from "../src/engine/stall-detector.ts";
import { createInFlightProbe } from "../src/engine/stall-quiescence.ts";
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
    worktreeFingerprint: "",
    inFlight: false,
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

  test("in-flight work holds the counter without incrementing or resetting it", () => {
    const detector = createStallDetector({ limits: { iterations: 3, adjudications: 0 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation({ inFlight: true })).stalled).toBe(false);
    expect(detector.observe(observation({ inFlight: true })).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(true);
  });

  test("progress observed while in flight survives into the next quiet observation", () => {
    const detector = createStallDetector({ limits: { iterations: 3, adjudications: 0 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation({ inFlight: true, worktreeFingerprint: "dirty-a" })).stalled).toBe(false);
    expect(detector.observe(observation({ worktreeFingerprint: "dirty-a" })).stalled).toBe(false);
    expect(detector.observe(observation({ worktreeFingerprint: "dirty-a" })).stalled).toBe(false);
    expect(detector.observe(observation({ worktreeFingerprint: "dirty-a" })).stalled).toBe(false);
    expect(detector.observe(observation({ worktreeFingerprint: "dirty-a" })).stalled).toBe(true);
  });

  test("resets the counter when the worktree fingerprint changes", () => {
    const detector = createStallDetector({ limits: { iterations: 2, adjudications: 0 }, initialAdjudicationCompletions: 0 });
    const dirty = { worktreeFingerprint: "src/a.ts\n1 file changed, 2 insertions(+)" };

    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation()).stalled).toBe(false);
    expect(detector.observe(observation(dirty)).stalled).toBe(false);
    expect(detector.observe(observation(dirty)).stalled).toBe(false);
    expect(detector.observe(observation(dirty)).stalled).toBe(true);
  });

  test("an identical dirty worktree fingerprint still trips", () => {
    const detector = createStallDetector({ limits: { iterations: 2, adjudications: 0 }, initialAdjudicationCompletions: 0 });
    const dirty = { worktreeFingerprint: "src/a.ts\n1 file changed, 2 insertions(+)" };

    expect(detector.observe(observation(dirty)).stalled).toBe(false);
    expect(detector.observe(observation(dirty)).stalled).toBe(false);
    expect(detector.observe(observation(dirty)).stalled).toBe(true);
  });

  test("an unknown worktree fingerprint fails open", () => {
    const detector = createStallDetector({ limits: { iterations: 1, adjudications: 0 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation({ worktreeFingerprint: undefined })).stalled).toBe(false);
    expect(detector.observe(observation({ worktreeFingerprint: undefined })).stalled).toBe(false);
    expect(detector.observe(observation({ worktreeFingerprint: undefined })).stalled).toBe(false);
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

  test("an in-flight iteration never suppresses the adjudication cap", () => {
    const detector = createStallDetector({ limits: { iterations: 0, adjudications: 2 }, initialAdjudicationCompletions: 0 });

    expect(detector.observe(observation({ inFlight: true, adjudicationCompletions: 1 })).stalled).toBe(false);
    expect(detector.observe(observation({ inFlight: true, adjudicationCompletions: 2 })).stalled).toBe(true);
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

  function prdObserver(repoDir: string, iterations: number) {
    return createStallObserver({
      repoDir,
      limits: { iterations, adjudications: 0 },
      prdDir: join(repoDir, "spec"),
      readCompletionsCount: () => 0,
      readPasses: () => ({ "US-1": false }),
    });
  }

  test("stalls on idle iterations, ignores PRD-only commits, resets on production commits", async () => {
    const repoDir = await gitScratch();
    const observer = prdObserver(repoDir, 2);

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

  test("an uncommitted edit to a tracked production file produces no strike", async () => {
    const repoDir = await gitScratch();
    const observer = prdObserver(repoDir, 2);

    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    writeFileSync(join(repoDir, "tracked.txt"), "work in progress, not yet committed\n");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
  });

  test("an untracked material file produces no strike", async () => {
    const repoDir = await gitScratch();
    const observer = prdObserver(repoDir, 2);

    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    writeFileSync(join(repoDir, "new-module.ts"), "export const added = 1;\n");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
  });

  test("an uncommitted edit confined to the PRD dir still trips", async () => {
    const repoDir = await gitScratch();
    const observer = prdObserver(repoDir, 2);

    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    writeFileSync(join(repoDir, "spec", "progress.txt"), "iteration 1 notes\n");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    writeFileSync(join(repoDir, "spec", "progress.txt"), "iteration 2 notes\n");
    writeFileSync(join(repoDir, "spec", "scratch.md"), "untracked prd churn\n");
    const verdict = await observer.checkIteration("us-1-story");

    expect(verdict.stalled).toBe(true);
    if (verdict.stalled) expect(verdict.reason).toContain("no material progress on US-1");
  });

  // Permission-gate hold, with its control. A run parked on a human permission
  // gate must never score a stall strike, and two independent mechanisms hold
  // that line:
  //   1. While the gate is open the step timeout is paused and `runIteration`
  //      has not returned, so `runStallCheck` is never even reached.
  //   2. If an iteration does end with the gated session still parked (step
  //      timeout, retry, background continuation), opencode still reports that
  //      session busy, so the real `createInFlightProbe` reads in-flight and the
  //      detector HOLDS the counter rather than scoring an unearned strike.
  // These tests prove (2) through the production probe chain - session status ->
  // probeBackgroundLiveness -> createInFlightProbe -> observer - because that is
  // the mechanism that could silently regress. The control is the same quiescent
  // no-progress repo with the gate answered, so a green pair means the hold comes
  // from the gate and not from a detector that simply stopped counting.
  function gatedObserver(repoDir: string, sessionStatusType: () => string) {
    const client = {
      session: {
        children: async () => ({ data: [] }),
        status: async () => ({ data: { ses_gated: { type: sessionStatusType() } } }),
      },
    };
    return createStallObserver({
      repoDir,
      limits: { iterations: 2, adjudications: 0 },
      prdDir: join(repoDir, "spec"),
      readCompletionsCount: () => 0,
      readPasses: () => ({ "US-1": false }),
      probeInFlight: createInFlightProbe({
        repoDir,
        client,
        currentIteration: () => ({ sessions: [{ stepIndex: 0, stepName: "Build", sessionID: "ses_gated" }], startedAt: Date.now() }),
      }),
    });
  }

  test("a run blocked on a pending human permission gate scores no stall strikes", async () => {
    const repoDir = await gitScratch();
    let sessionStatusType = "busy";
    const observer = gatedObserver(repoDir, () => sessionStatusType);

    for (let index = 0; index < 6; index += 1) {
      expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    }

    // Gate answered: the session goes idle and the identical no-progress run
    // starts scoring strikes again, proving the hold was the gate.
    sessionStatusType = "idle";
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(true);
  });

  test("control: the equivalent quiescent no-progress run with no gate open accumulates stall strikes", async () => {
    const repoDir = await gitScratch();
    const observer = gatedObserver(repoDir, () => "idle");

    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(true);
  });

  test("confirmStall re-samples without advancing the detector", async () => {
    const repoDir = await gitScratch();
    const observer = prdObserver(repoDir, 2);

    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(true);

    expect(await observer.confirmStall("us-1-story")).toBe(true);

    writeFileSync(join(repoDir, "tracked.txt"), "late uncommitted work\n");
    expect(await observer.confirmStall("us-1-story")).toBe(false);
  });

  test("a same-line-count edit to an already-dirty tracked file is progress", async () => {
    const repoDir = await gitScratch();
    const observer = prdObserver(repoDir, 2);

    writeFileSync(join(repoDir, "tracked.txt"), "aaa\n");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    writeFileSync(join(repoDir, "tracked.txt"), "bbb\n");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
  });

  test("editing an untracked material file in place is progress", async () => {
    const repoDir = await gitScratch();
    const observer = prdObserver(repoDir, 2);

    writeFileSync(join(repoDir, "new-module.ts"), "export const added = 1;\n");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    writeFileSync(join(repoDir, "new-module.ts"), "export const added = 2;\n");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
  });

  test("PRD-only churn never resets the counter while material dirt is unchanged", async () => {
    const repoDir = await gitScratch();
    const observer = prdObserver(repoDir, 2);

    writeFileSync(join(repoDir, "tracked.txt"), "material work in progress\n");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    writeFileSync(join(repoDir, "spec", "progress.txt"), "iteration 1 notes\n");
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);

    writeFileSync(join(repoDir, "spec", "progress.txt"), "iteration 2 notes\n");
    const verdict = await observer.checkIteration("us-1-story");

    expect(verdict.stalled).toBe(true);
  });

  test("confirmStall fails open before any observation", async () => {
    const repoDir = await gitScratch();
    const observer = prdObserver(repoDir, 2);

    expect(await observer.confirmStall("us-1-story")).toBe(false);
  });

  test("confirmStall fails open when the story phase advances during the window", async () => {
    const repoDir = await gitScratch();
    let phase = "building";
    const observer = createStallObserver({
      repoDir,
      limits: { iterations: 2, adjudications: 0 },
      prdDir: join(repoDir, "spec"),
      readCompletionsCount: () => 0,
      readPasses: () => ({ "US-1": false }),
      readPhase: () => phase,
    });

    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(true);
    expect(await observer.confirmStall("us-1-story")).toBe(true);

    phase = "implemented";
    expect(await observer.confirmStall("us-1-story")).toBe(false);
  });

  test("confirmStall fails open when PRD passes change during the window", async () => {
    const repoDir = await gitScratch();
    let passes: Record<string, boolean> = { "US-1": false };
    const observer = createStallObserver({
      repoDir,
      limits: { iterations: 2, adjudications: 0 },
      prdDir: join(repoDir, "spec"),
      readCompletionsCount: () => 0,
      readPasses: () => passes,
    });

    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(true);
    expect(await observer.confirmStall("us-1-story")).toBe(true);

    passes = { "US-1": true };
    expect(await observer.confirmStall("us-1-story")).toBe(false);
  });

  test("configured but unreadable PRD passes hold the counter and never trip", async () => {
    const repoDir = await gitScratch();
    const observer = createStallObserver({
      repoDir,
      limits: { iterations: 2, adjudications: 0 },
      prdDir: join(repoDir, "spec"),
      readCompletionsCount: () => 0,
      readPasses: () => undefined,
    });

    for (let index = 0; index < 6; index += 1) {
      expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    }
  });

  test("an unreadable PRD only holds the counter when a prdDir is configured", async () => {
    const repoDir = await gitScratch();
    const observer = createStallObserver({
      repoDir,
      limits: { iterations: 2, adjudications: 0 },
      readCompletionsCount: () => 0,
    });

    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(true);
  });

  test("confirmStall refuses to confirm while configured PRD passes are unreadable", async () => {
    const repoDir = await gitScratch();
    let completions = 0;
    const observer = createStallObserver({
      repoDir,
      limits: { iterations: 0, adjudications: 2 },
      prdDir: join(repoDir, "spec"),
      readCompletionsCount: () => completions,
      readPasses: () => undefined,
    });

    completions = 1;
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    completions = 2;
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(true);

    expect(await observer.confirmStall("us-1-story")).toBe(false);
  });

  test("confirmStall still confirms an unreadable PRD when no prdDir is configured", async () => {
    const repoDir = await gitScratch();
    let completions = 0;
    const observer = createStallObserver({
      repoDir,
      limits: { iterations: 0, adjudications: 2 },
      readCompletionsCount: () => completions,
    });

    completions = 1;
    expect((await observer.checkIteration("main")).stalled).toBe(false);
    completions = 2;
    expect((await observer.checkIteration("main")).stalled).toBe(true);

    expect(await observer.confirmStall("main")).toBe(true);
  });

  test("confirmStall fails open when an adjudication completes during the window", async () => {
    const repoDir = await gitScratch();
    let completions = 0;
    const observer = createStallObserver({
      repoDir,
      limits: { iterations: 2, adjudications: 0 },
      prdDir: join(repoDir, "spec"),
      readCompletionsCount: () => completions,
      readPasses: () => ({ "US-1": false }),
    });

    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(false);
    expect((await observer.checkIteration("us-1-story")).stalled).toBe(true);
    expect(await observer.confirmStall("us-1-story")).toBe(true);

    completions = 1;
    expect(await observer.confirmStall("us-1-story")).toBe(false);
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

describe("createInFlightProbe", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function probeFor(client: unknown, sessionIDs: readonly string[]): () => Promise<boolean> {
    const repoDir = mkdtempSync(join(tmpdir(), "looper-inflight-"));
    scratchDirs.push(repoDir);
    return createInFlightProbe({
      repoDir,
      client,
      currentIteration: () => ({
        sessions: sessionIDs.map((sessionID, stepIndex) => ({ stepIndex, stepName: `Step${stepIndex}`, sessionID })),
        startedAt: Date.now(),
      }),
    });
  }

  function statusClient(statuses: Record<string, { type: string }>, children: readonly { id: string }[] = []) {
    return {
      session: {
        children: async () => ({ data: [...children] }),
        status: async () => ({ data: statuses }),
      },
    };
  }

  test("reports idle when no sessions are tracked", async () => {
    expect(await probeFor({}, [])()).toBe(false);
  });

  test("reports in flight when sessions are tracked but the client cannot be probed", async () => {
    expect(await probeFor({}, ["ses_1"])()).toBe(true);
  });

  test("reports in flight when the liveness probe throws", async () => {
    const client = {
      session: {
        children: async () => {
          throw new Error("boom");
        },
        status: async () => ({ data: {} }),
      },
    };

    expect(await probeFor(client, ["ses_1"])()).toBe(true);
  });

  test("reports in flight when a tracked parent session is pending", async () => {
    expect(await probeFor(statusClient({ ses_1: { type: "busy" } }), ["ses_1"])()).toBe(true);
  });

  test("reports in flight when a tracked session has a pending child", async () => {
    const client = statusClient({ ses_1: { type: "idle" }, ses_child: { type: "busy" } }, [{ id: "ses_child" }]);

    expect(await probeFor(client, ["ses_1"])()).toBe(true);
  });

  test("reports idle when every tracked session is idle", async () => {
    expect(await probeFor(statusClient({ ses_1: { type: "idle" } }), ["ses_1"])()).toBe(false);
  });
});

describe("runEngine stall integration", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function engineScratch(prefix: string): Promise<{ repoDir: string; configDir: string; store: ReturnType<typeof createRunStateStore> }> {
    const repoDir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(repoDir);
    await $`git init -q -b main`.cwd(repoDir).quiet();
    writeFileSync(join(repoDir, "tracked.txt"), "base\n");
    await $`git add -A`.cwd(repoDir).quiet();
    await $`git -c user.email=t@t -c user.name=t commit -q -m init`.cwd(repoDir).quiet();
    const configDir = join(repoDir, ".looper");
    mkdirSync(configDir, { recursive: true });
    initStatePaths({ configDir });
    const store = createRunStateStore({ configDir });
    store.clearStopFiles();
    return { repoDir, configDir, store };
  }

  test("an idle loop stops with a stall reason and writes the stop file", async () => {
    const { repoDir, configDir, store } = await engineScratch("looper-stall-engine-");

    const result = await runEngine({
      fresh: true,
      maxIterations: 10,
      waitProvided: false,
      waitDuration: 0,
      repoDir,
      configDir,
      client: {},
      store,
      hooks: { createIterationState: () => createLoopState({ maxIterations: 10, stepNames: ["Step1"] }) },
      loadSteps: () => [{ name: "Step1", prompt: join(configDir, "step1.md") }],
      currentBranch: async () => "main",
      createLooperRunID: () => "run-stall",
      legacyResumeStepIndex: () => 0,
      runIteration: async () => "complete",
      adjudication: { store: createInMemoryAdjudicationStore(), threshold: 2 },
      stall: { iterations: 2, adjudications: 3 },
      stallConfirmMs: 0,
    });

    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toContain("stall detected");
    expect(existsSync(join(configDir, ".looper-stop"))).toBe(true);
  });

  test("a tripped stall that is not confirmed writes no stop file and the run continues", async () => {
    const { repoDir, configDir, store } = await engineScratch("looper-stall-unconfirmed-");
    let iterationsRun = 0;
    let branchCallsThisIteration = 0;

    const result = await runEngine({
      fresh: true,
      maxIterations: 4,
      waitProvided: false,
      waitDuration: 0,
      repoDir,
      configDir,
      client: {},
      store,
      hooks: { createIterationState: () => createLoopState({ maxIterations: 4, stepNames: ["Step1"] }) },
      loadSteps: () => [{ name: "Step1", prompt: join(configDir, "step1.md") }],
      currentBranch: async () => {
        branchCallsThisIteration += 1;
        // After an iteration body the engine asks for the branch once for the
        // stall check and once more for the confirmation re-sample. Landing work
        // on that second call reproduces the incident: the agent's uncommitted
        // edits appear between the tripped verdict and the confirmation.
        if (iterationsRun === 3 && branchCallsThisIteration === 2) writeFileSync(join(repoDir, "tracked.txt"), "late uncommitted work\n");
        return "main";
      },
      createLooperRunID: () => "run-stall-unconfirmed",
      legacyResumeStepIndex: () => 0,
      runIteration: async () => {
        iterationsRun += 1;
        branchCallsThisIteration = 0;
        return "complete";
      },
      stall: { iterations: 2, adjudications: 0 },
      stallConfirmMs: 0,
    });

    expect(result.kind).toBe("max-iterations");
    expect(iterationsRun).toBe(4);
    expect(existsSync(join(configDir, ".looper-stop"))).toBe(false);
  });

  test("a confirmed stall writes the stop file", async () => {
    const { repoDir, configDir, store } = await engineScratch("looper-stall-confirmed-");
    let iterationsRun = 0;

    const result = await runEngine({
      fresh: true,
      maxIterations: 4,
      waitProvided: false,
      waitDuration: 0,
      repoDir,
      configDir,
      client: {},
      store,
      hooks: { createIterationState: () => createLoopState({ maxIterations: 4, stepNames: ["Step1"] }) },
      loadSteps: () => [{ name: "Step1", prompt: join(configDir, "step1.md") }],
      currentBranch: async () => "main",
      createLooperRunID: () => "run-stall-confirmed",
      legacyResumeStepIndex: () => 0,
      runIteration: async () => {
        iterationsRun += 1;
        return "complete";
      },
      stall: { iterations: 2, adjudications: 0 },
      stallConfirmMs: 0,
    });

    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toContain("stall detected");
    expect(iterationsRun).toBe(3);
    expect(existsSync(join(configDir, ".looper-stop"))).toBe(true);
  });
});
