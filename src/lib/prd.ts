import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { comparePhase, type StoryPhase } from "./story-state-files.ts";

export const PRD_INDEX_FILENAME = "prd.json";
export const PRD_PROGRESS_FILENAME = "progress.txt";

export type PrdPaths = {
  readonly dir: string;
  readonly index: string;
  readonly progress: string;
};

export type PrdStory = {
  readonly id: string;
  readonly title?: string;
  readonly priority?: number;
  readonly dependsOn: readonly string[];
};

export type PrdCountInput = {
  readonly stories: readonly PrdStory[];
  readonly phases: Readonly<Record<string, StoryPhase>>;
  readonly terminal: StoryPhase;
};

export type PrdCounts = {
  readonly remaining: number;
  readonly total: number;
};

export function prdIndexPath(prdDir: string): string {
  return join(prdDir, PRD_INDEX_FILENAME);
}

export function derivePrdPaths(prdDir: string, repoDir: string): PrdPaths {
  const relativeDir = relative(repoDir, prdDir);
  const insideRepo =
    relativeDir === "" ||
    (relativeDir !== ".." && !relativeDir.startsWith(`..${sep}`) && !isAbsolute(relativeDir));
  const dir = insideRepo ? relativeDir || "." : prdDir;
  return {
    dir,
    index: join(dir, PRD_INDEX_FILENAME),
    progress: join(dir, PRD_PROGRESS_FILENAME),
  };
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDependsOn(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const deps: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) deps.push(entry);
  }
  return deps;
}

function parseStory(value: unknown): PrdStory | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) return undefined;
  const titleRaw = value["title"];
  const title = typeof titleRaw === "string" ? titleRaw : undefined;
  const priorityRaw = value["priority"];
  const priority =
    typeof priorityRaw === "number" && Number.isFinite(priorityRaw) ? priorityRaw : undefined;
  const dependsOn = parseDependsOn(value["dependsOn"]);
  return {
    id,
    dependsOn,
    ...(title !== undefined ? { title } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };
}

/**
 * Parse prd.json user stories. Ignores `passes` (spec-only; phases are story truth).
 * Returns undefined when the file is missing, unreadable, or not a valid stories document.
 */
export function readPrdStories(indexPath: string): PrdStory[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(indexPath, "utf8");
  } catch {
    // no-excuse-ok: catch -- missing/unreadable prd is a soft "no snapshot" boundary
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // no-excuse-ok: catch -- malformed JSON is a soft "no snapshot" boundary
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["userStories"])) return undefined;
  const stories: PrdStory[] = [];
  for (const entry of parsed["userStories"]) {
    const story = parseStory(entry);
    if (story !== undefined) stories.push(story);
  }
  return stories;
}

/** Count stories whose effective phase is still below the terminal phase. */
export function countPrd(snapshot: PrdCountInput): PrdCounts {
  const total = snapshot.stories.length;
  let remaining = 0;
  for (const story of snapshot.stories) {
    const phase = snapshot.phases[story.id] ?? "building";
    if (comparePhase(phase, snapshot.terminal) < 0) remaining += 1;
  }
  return { remaining, total };
}
