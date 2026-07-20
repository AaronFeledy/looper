import { join } from "node:path";

import { requireConfigDir, tolerantRead, tolerantRm, writeFileAtomically } from "./state-files.ts";

const STORY_STATE_FILE_NAME = ".looper-story-state.json";

export const STORY_PHASE_ORDER = ["building", "implemented", "reviewed", "verified", "published", "merged"] as const;

export type StoryPhase = (typeof STORY_PHASE_ORDER)[number];

type StoryStateEntry = {
  readonly phase: StoryPhase;
  readonly updatedAt: string;
};

type StoryStateFile = {
  readonly stories: Readonly<Record<string, StoryStateEntry>>;
};

function storyStatePath(): string {
  return join(requireConfigDir(), STORY_STATE_FILE_NAME);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidPhase(value: string): value is StoryPhase {
  return STORY_PHASE_ORDER.some((phase) => phase === value);
}

export function comparePhase(a: StoryPhase, b: StoryPhase): number {
  return STORY_PHASE_ORDER.indexOf(a) - STORY_PHASE_ORDER.indexOf(b);
}

function parseStoryState(content: string | null): StoryStateFile {
  if (content === null) return { stories: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { stories: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed["stories"])) return { stories: {} };

  const stories: Record<string, StoryStateEntry> = {};
  for (const [storyId, value] of Object.entries(parsed["stories"])) {
    if (storyId.length === 0 || !isRecord(value)) return { stories: {} };
    const phase = value["phase"];
    const updatedAt = value["updatedAt"];
    if (typeof phase !== "string" || !isValidPhase(phase) || typeof updatedAt !== "string" || updatedAt.length === 0) {
      return { stories: {} };
    }
    stories[storyId] = { phase, updatedAt };
  }
  return { stories };
}

function readStoryState(): StoryStateFile {
  return parseStoryState(tolerantRead(storyStatePath()));
}

export function readStoryPhase(storyId: string): StoryPhase | undefined {
  return readStoryState().stories[storyId]?.phase;
}

export function writeStoryPhase(storyId: string, phase: StoryPhase): void {
  const current = readStoryState();
  const next: StoryStateFile = {
    stories: {
      ...current.stories,
      [storyId]: { phase, updatedAt: new Date().toISOString() },
    },
  };
  writeFileAtomically(storyStatePath(), `${JSON.stringify(next, null, 2)}\n`);
}

export function clearStoryState(): void {
  tolerantRm(storyStatePath());
}
