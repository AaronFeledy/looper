import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStoryPhaseResolver,
  deriveStoryPhases,
  isPrdComplete,
  selectNextStory,
  type StoryPhaseSnapshot,
} from "../src/engine/story-phases.ts";
import { prdIndexPath, type PrdStory } from "../src/lib/prd.ts";
import type { StoryPhase } from "../src/lib/story-state-files.ts";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function snapshot(partial: {
  stories: readonly PrdStory[];
  phases?: Readonly<Record<string, StoryPhase>>;
  terminal?: StoryPhase;
}): StoryPhaseSnapshot {
  return {
    stories: partial.stories,
    phases: partial.phases ?? {},
    terminal: partial.terminal ?? "merged",
  };
}

function story(id: string, opts: { priority?: number; dependsOn?: readonly string[]; title?: string } = {}): PrdStory {
  return {
    id,
    dependsOn: opts.dependsOn ?? [],
    ...(opts.title !== undefined ? { title: opts.title } : { title: id }),
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
  };
}

describe("selectNextStory", () => {
  test("prefers the in-flight branch story when it is below terminal", () => {
    const snap = snapshot({
      stories: [story("US-1", { priority: 1 }), story("US-2", { priority: 2 })],
      phases: { "US-1": "building", "US-2": "building" },
    });

    expect(selectNextStory(snap, "US-2")?.story.id).toBe("US-2");
  });

  test("ignores branch story when it is already terminal", () => {
    const snap = snapshot({
      stories: [story("US-1", { priority: 1 }), story("US-2", { priority: 2 })],
      phases: { "US-1": "building", "US-2": "merged" },
    });

    expect(selectNextStory(snap, "US-2")?.story.id).toBe("US-1");
  });

  test("picks the lowest priority ready story whose known deps are terminal", () => {
    const snap = snapshot({
      stories: [
        story("US-2", { priority: 2, dependsOn: ["US-1"] }),
        story("US-1", { priority: 1 }),
        story("US-3", { priority: 3, dependsOn: ["MISSING"] }),
      ],
      phases: { "US-1": "merged", "US-2": "building", "US-3": "building" },
    });

    // US-2 deps satisfied; US-3 unknown dep treated as satisfied; priority picks US-2 first.
    expect(selectNextStory(snap, undefined)?.story.id).toBe("US-2");
  });

  test("sorts missing priority after present priorities and breaks ties by array order", () => {
    const snap = snapshot({
      stories: [
        story("US-B", { priority: 5 }),
        story("US-A", { priority: 5 }),
        story("US-Z"),
        story("US-C", { priority: 1 }),
      ],
      phases: {},
    });

    expect(selectNextStory(snap, undefined)?.story.id).toBe("US-C");

    const withoutC = snapshot({
      stories: [story("US-B", { priority: 5 }), story("US-A", { priority: 5 }), story("US-Z")],
      phases: {},
    });
    expect(selectNextStory(withoutC, undefined)?.story.id).toBe("US-B");
  });

  test("on dependency deadlock picks first non-terminal and reason names unmet deps", () => {
    const snap = snapshot({
      stories: [
        story("US-1", { priority: 1, dependsOn: ["US-2"] }),
        story("US-2", { priority: 2, dependsOn: ["US-1"] }),
      ],
      phases: { "US-1": "building", "US-2": "building" },
    });

    const next = selectNextStory(snap, undefined);

    expect(next?.story.id).toBe("US-1");
    expect(next?.reason).toBeDefined();
    expect(next?.reason).toContain("US-2");
    expect(next?.reason).toMatch(/unmet dependencies/i);
  });

  test("returns undefined when every story is terminal", () => {
    const snap = snapshot({
      stories: [story("US-1"), story("US-2")],
      phases: { "US-1": "merged", "US-2": "merged" },
    });
    expect(selectNextStory(snap, undefined)).toBeUndefined();
  });
});

describe("isPrdComplete", () => {
  test("is false for an empty story list", () => {
    expect(isPrdComplete(snapshot({ stories: [] }))).toBe(false);
  });

  test("is true only when every story is at or past terminal", () => {
    const stories = [story("A"), story("B")];
    expect(
      isPrdComplete(snapshot({ stories, phases: { A: "merged", B: "published" }, terminal: "merged" })),
    ).toBe(false);
    expect(
      isPrdComplete(snapshot({ stories, phases: { A: "merged", B: "merged" }, terminal: "merged" })),
    ).toBe(true);
    expect(
      isPrdComplete(snapshot({ stories, phases: { A: "verified", B: "verified" }, terminal: "verified" })),
    ).toBe(true);
  });
});

describe("createStoryPhaseResolver", () => {
  test("snapshot is undefined when prd is unreadable", () => {
    const stored = new Map<string, StoryPhase>();
    const resolver = createStoryPhaseResolver({
      repoDir: scratch("looper-phase-repo-"),
      prdIndex: join(scratch("looper-phase-prd-"), "missing.json"),
      storyState: {
        readPhase: (id) => stored.get(id),
        writePhase: (id, phase) => {
          stored.set(id, phase);
        },
      },
      derive: () => ({}),
      storyFetchTimeoutMs: 0,
    });

    expect(resolver.snapshot()).toBeUndefined();
  });

  test("snapshot derives fresh, uses max(stored, derived), and persists upgrades", () => {
    const prdDir = scratch("looper-phase-prd-");
    writeFileSync(
      prdIndexPath(prdDir),
      JSON.stringify({
        userStories: [
          { id: "US-1", title: "one" },
          { id: "US-2", title: "two" },
        ],
      }),
    );
    const stored = new Map<string, StoryPhase>([["US-1", "implemented"]]);
    const logs: string[] = [];
    let deriveCalls = 0;

    const resolver = createStoryPhaseResolver({
      repoDir: scratch("looper-phase-repo-"),
      prdIndex: prdIndexPath(prdDir),
      storyState: {
        readPhase: (id) => stored.get(id),
        writePhase: (id, phase) => {
          stored.set(id, phase);
        },
      },
      derive: () => {
        deriveCalls += 1;
        return { "US-1": "merged", "US-2": "published" };
      },
      storyFetchTimeoutMs: 0,
      log: (line) => logs.push(line),
    });

    const first = resolver.snapshot();
    expect(deriveCalls).toBe(1);
    expect(first?.phases["US-1"]).toBe("merged");
    expect(first?.phases["US-2"]).toBe("published");
    expect(stored.get("US-1")).toBe("merged");
    expect(stored.get("US-2")).toBe("published");
    expect(logs).toEqual([
      "[looper] story US-1: phase merged (derived from git)",
      "[looper] story US-2: phase published (derived from git)",
    ]);

    // Each snapshot re-derives (no cache).
    resolver.snapshot();
    expect(deriveCalls).toBe(2);

    // Derived lower than stored must not regress.
    const resolver2 = createStoryPhaseResolver({
      repoDir: scratch("looper-phase-repo-"),
      prdIndex: prdIndexPath(prdDir),
      storyState: {
        readPhase: (id) => stored.get(id),
        writePhase: (id, phase) => {
          stored.set(id, phase);
        },
      },
      derive: () => ({ "US-1": "building" }),
      storyFetchTimeoutMs: 0,
    });
    const snap2 = resolver2.snapshot();
    expect(snap2?.phases["US-1"]).toBe("merged");
    expect(stored.get("US-1")).toBe("merged");
  });

  test("fetchMain with timeout 0 skips fetch and does not derive", async () => {
    const prdDir = scratch("looper-phase-prd-");
    writeFileSync(prdIndexPath(prdDir), JSON.stringify({ userStories: [{ id: "US-9", title: "n" }] }));
    let deriveCalls = 0;
    const stored = new Map<string, StoryPhase>();
    const resolver = createStoryPhaseResolver({
      repoDir: scratch("looper-phase-repo-"),
      prdIndex: prdIndexPath(prdDir),
      storyState: {
        readPhase: (id) => stored.get(id),
        writePhase: (id, phase) => {
          stored.set(id, phase);
        },
      },
      derive: () => {
        deriveCalls += 1;
        return { "US-9": "published" };
      },
      storyFetchTimeoutMs: 0,
    });

    await resolver.fetchMain();
    expect(deriveCalls).toBe(0);
    // snapshot still derives on demand
    expect(resolver.snapshot()?.phases["US-9"]).toBe("published");
    expect(deriveCalls).toBe(1);
  });
});

describe("deriveStoryPhases (real git)", () => {
  function git(cwd: string, args: readonly string[]): void {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
    }
  }

  test("marks remote story branches published and merged ancestors as merged", () => {
    // Given a temporary bare origin and a working clone with story branches.
    const root = scratch("looper-derive-git-");
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    mkdirSync(origin);
    git(origin, ["init", "--bare"]);
    // Default branch name for new repos may be master; force main.
    git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    mkdirSync(work);
    git(work, ["init"]);
    git(work, ["config", "user.email", "looper@example.com"]);
    git(work, ["config", "user.name", "Looper Test"]);
    git(work, ["checkout", "-b", "main"]);
    writeFileSync(join(work, "README"), "main\n");
    git(work, ["add", "README"]);
    git(work, ["commit", "-m", "init"]);
    git(work, ["remote", "add", "origin", origin]);
    git(work, ["push", "-u", "origin", "main"]);

    // US-MERGED: branch created from main, merged back into main, pushed.
    git(work, ["checkout", "-b", "us-merged-feature"]);
    writeFileSync(join(work, "merged.txt"), "m\n");
    git(work, ["add", "merged.txt"]);
    git(work, ["commit", "-m", "merged work"]);
    git(work, ["checkout", "main"]);
    git(work, ["merge", "--no-ff", "us-merged-feature", "-m", "merge us-merged"]);
    git(work, ["push", "origin", "main"]);
    git(work, ["push", "origin", "us-merged-feature"]);

    // US-PUB: branch pushed to origin but not merged into main.
    git(work, ["checkout", "-b", "us-pub-feature"]);
    writeFileSync(join(work, "pub.txt"), "p\n");
    git(work, ["add", "pub.txt"]);
    git(work, ["commit", "-m", "published work"]);
    git(work, ["push", "-u", "origin", "us-pub-feature"]);

    // US-LOCAL: local-only branch, not on origin → no derived phase.
    git(work, ["checkout", "-b", "us-local-feature"]);
    writeFileSync(join(work, "local.txt"), "l\n");
    git(work, ["add", "local.txt"]);
    git(work, ["commit", "-m", "local work"]);

    git(work, ["checkout", "main"]);
    git(work, ["fetch", "origin"]);

    const storyIds = ["US-MERGED", "US-PUB", "US-LOCAL", "US-NONE"];

    // When phases are derived from git (sync).
    const derived = deriveStoryPhases({
      repoDir: work,
      storyIds,
      mainBranch: "main",
      storyIdPattern: "^([a-z]+-[a-z0-9]+)-",
    });

    // Then merge-base ancestry yields merged; remote-only yields published; local-only/none absent.
    expect(derived["US-MERGED"]).toBe("merged");
    expect(derived["US-PUB"]).toBe("published");
    expect(derived["US-LOCAL"]).toBeUndefined();
    expect(derived["US-NONE"]).toBeUndefined();
  });

  test("returns empty map on git failure without throwing", () => {
    const notARepo = scratch("looper-derive-nongit-");
    const derived = deriveStoryPhases({
      repoDir: notARepo,
      storyIds: ["US-1"],
      mainBranch: "main",
    });
    expect(derived).toEqual({});
  });
});
