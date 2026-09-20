import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStoryPhaseResolver,
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
  function resolverFor(stored: Map<string, StoryPhase>, prdIndex: string) {
    return createStoryPhaseResolver({
      repoDir: scratch("looper-phase-repo-"),
      prdIndex,
      storyState: { readPhase: (id) => stored.get(id) },
      storyFetchTimeoutMs: 0,
    });
  }

  test("snapshot is undefined when prd is unreadable", () => {
    const resolver = resolverFor(new Map(), join(scratch("looper-phase-prd-"), "missing.json"));
    expect(resolver.snapshot()).toBeUndefined();
  });

  test("snapshot reports stored phases and defaults the rest to building", () => {
    const prdDir = scratch("looper-phase-prd-");
    writeFileSync(
      prdIndexPath(prdDir),
      JSON.stringify({ userStories: [{ id: "US-1", title: "one" }, { id: "US-2", title: "two" }] }),
    );
    const stored = new Map<string, StoryPhase>([["US-1", "implemented"]]);

    const snap = resolverFor(stored, prdIndexPath(prdDir)).snapshot();

    expect(snap?.phases["US-1"]).toBe("implemented");
    expect(snap?.phases["US-2"]).toBe("building");
  });

  test("snapshot never writes: phase is asserted by signals, never inferred", () => {
    // The whole failure class this removed: a guess about git topology used to be
    // persisted into the authoritative store, so one wrong guess was permanent.
    // An empty story branch was recorded `merged` with zero commits and gated off
    // every step that could have finished the story.
    const prdDir = scratch("looper-phase-prd-");
    writeFileSync(prdIndexPath(prdDir), JSON.stringify({ userStories: [{ id: "US-1", title: "one" }] }));
    const stored = new Map<string, StoryPhase>([["US-1", "building"]]);
    const writes: string[] = [];

    const resolver = createStoryPhaseResolver({
      repoDir: scratch("looper-phase-repo-"),
      prdIndex: prdIndexPath(prdDir),
      storyState: {
        readPhase: (id: string) => stored.get(id),
        // Present but must never be called; the resolver only needs readPhase.
        writePhase: (id: string, phase: StoryPhase) => void writes.push(`${id}=${phase}`),
      } as never,
      storyFetchTimeoutMs: 0,
    });

    resolver.snapshot();
    resolver.snapshot();

    expect(writes).toEqual([]);
    expect(stored.get("US-1")).toBe("building");
  });

  test("fetchMain with timeout 0 is a no-op and never throws", async () => {
    const prdDir = scratch("looper-phase-prd-");
    writeFileSync(prdIndexPath(prdDir), JSON.stringify({ userStories: [{ id: "US-9", title: "n" }] }));
    const resolver = resolverFor(new Map([["US-9", "published"]]), prdIndexPath(prdDir));

    await resolver.fetchMain();

    expect(resolver.snapshot()?.phases["US-9"]).toBe("published");
  });

  test("fetchMain against a non-repo never throws", async () => {
    const prdDir = scratch("looper-phase-prd-");
    writeFileSync(prdIndexPath(prdDir), JSON.stringify({ userStories: [{ id: "US-9", title: "n" }] }));
    const resolver = createStoryPhaseResolver({
      repoDir: scratch("looper-phase-nonrepo-"),
      prdIndex: prdIndexPath(prdDir),
      storyState: { readPhase: () => undefined },
      storyFetchTimeoutMs: 1000,
    });

    expect(await resolver.fetchMain().then(() => "ok")).toBe("ok");
  });
});
