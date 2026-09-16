import { comparePhase, type StoryPhase } from "../lib/story-state-files.ts";
import { readPrdStories, type PrdStory } from "../lib/prd.ts";
import { storyFetchTimeoutMs } from "../config/tunables.ts";
import {
  DEFAULT_STORY_PHASE_GIT_TIMEOUT_MS,
  deriveStoryPhases,
  fetchOriginMain,
  type DeriveStoryPhases,
} from "./story-phase-git.ts";

export {
  deriveStoryPhases,
  type DeriveStoryPhases,
  type DeriveStoryPhasesInput,
} from "./story-phase-git.ts";

const DEFAULT_TERMINAL_PHASE: StoryPhase = "merged";
const DEFAULT_MAIN_BRANCH = "main";

export type StoryPhaseSnapshot = {
  readonly stories: readonly PrdStory[];
  readonly phases: Readonly<Record<string, StoryPhase>>;
  readonly terminal: StoryPhase;
};

export type StoryStateReaderWriter = {
  readonly readPhase: (storyId: string) => StoryPhase | undefined;
  readonly writePhase: (storyId: string, phase: StoryPhase) => void;
};

export type StoryPhaseResolver = {
  /**
   * Sync: read stories + stored phases + fresh derived git phases, persist upgrades,
   * return effective max(stored, derived). undefined when prd.json is unreadable.
   */
  readonly snapshot: () => StoryPhaseSnapshot | undefined;
  /** Best-effort `git fetch origin <mainBranch>`. Never throws. Does not derive. */
  readonly fetchMain: () => Promise<void>;
};

export type CreateStoryPhaseResolverInput = {
  readonly repoDir: string;
  readonly prdIndex: string;
  readonly storyState: StoryStateReaderWriter;
  readonly mainBranch?: string;
  readonly storyIdPattern?: string;
  readonly terminalPhase?: StoryPhase;
  readonly log?: (line: string) => void;
  readonly derive?: DeriveStoryPhases;
  /** `LOOPER_STORY_FETCH_TIMEOUT_MS`; default 15000; `0` disables fetch. */
  readonly storyFetchTimeoutMs?: number;
  readonly readStories?: (indexPath: string) => PrdStory[] | undefined;
  readonly gitTimeoutMs?: number;
};

function maxPhase(a: StoryPhase, b: StoryPhase): StoryPhase {
  return comparePhase(a, b) >= 0 ? a : b;
}

function resolveFetchTimeoutMs(value: number | undefined): number {
  if (value !== undefined) return value >= 0 && Number.isFinite(value) ? value : storyFetchTimeoutMs();
  return storyFetchTimeoutMs();
}

function compareStoryOrder(a: PrdStory, aIndex: number, b: PrdStory, bIndex: number): number {
  const aHas = a.priority !== undefined ? 0 : 1;
  const bHas = b.priority !== undefined ? 0 : 1;
  if (aHas !== bHas) return aHas - bHas;
  if (a.priority !== undefined && b.priority !== undefined && a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  return aIndex - bIndex;
}

function sortStoriesByPriority(stories: readonly PrdStory[]): PrdStory[] {
  return stories
    .map((story, index) => ({ story, index }))
    .sort((left, right) => compareStoryOrder(left.story, left.index, right.story, right.index))
    .map((entry) => entry.story);
}

export type SelectNextStoryResult = {
  readonly story: PrdStory;
  /** Present on dependency deadlock (rule 3): names the unmet dependsOn entries. */
  readonly reason?: string;
};

/**
 * Pick the next story to work on.
 * 1. In-flight branch story wins when still below terminal.
 * 2. Else first by priority among stories below terminal whose known dependsOn are all ≥ terminal
 *    (unknown dependency ids are treated as satisfied).
 * 3. Else first non-terminal by priority (dependency deadlock — keep moving; reason names unmet deps).
 * 4. Else undefined.
 */
export function selectNextStory(
  snapshot: StoryPhaseSnapshot,
  branchStoryId: string | undefined,
): SelectNextStoryResult | undefined {
  const phaseOf = (id: string): StoryPhase => snapshot.phases[id] ?? "building";
  const belowTerminal = (id: string): boolean => comparePhase(phaseOf(id), snapshot.terminal) < 0;
  const knownIds = new Set(snapshot.stories.map((story) => story.id));

  if (branchStoryId !== undefined && knownIds.has(branchStoryId) && belowTerminal(branchStoryId)) {
    const story = snapshot.stories.find((s) => s.id === branchStoryId);
    if (story !== undefined) return { story };
  }

  const ordered = sortStoriesByPriority(snapshot.stories);
  const unmetFor = (story: PrdStory): string[] => {
    const unmet: string[] = [];
    for (const dep of story.dependsOn) {
      if (!knownIds.has(dep)) continue;
      if (belowTerminal(dep)) unmet.push(dep);
    }
    return unmet;
  };

  const ready = ordered.filter((story) => belowTerminal(story.id) && unmetFor(story).length === 0);
  const firstReady = ready[0];
  if (firstReady !== undefined) return { story: firstReady };

  const blocked = ordered.filter((story) => belowTerminal(story.id));
  const firstBlocked = blocked[0];
  if (firstBlocked !== undefined) {
    const unmet = unmetFor(firstBlocked);
    const reason =
      unmet.length === 0
        ? `dependency deadlock selecting ${firstBlocked.id}`
        : `dependency deadlock selecting ${firstBlocked.id}: unmet dependencies ${unmet.join(", ")}`;
    return { story: firstBlocked, reason };
  }
  return undefined;
}

export function isPrdComplete(snapshot: StoryPhaseSnapshot): boolean {
  if (snapshot.stories.length === 0) return false;
  for (const story of snapshot.stories) {
    const phase = snapshot.phases[story.id] ?? "building";
    if (comparePhase(phase, snapshot.terminal) < 0) return false;
  }
  return true;
}

export function createStoryPhaseResolver(input: CreateStoryPhaseResolverInput): StoryPhaseResolver {
  const mainBranch = input.mainBranch ?? DEFAULT_MAIN_BRANCH;
  const terminal = input.terminalPhase ?? DEFAULT_TERMINAL_PHASE;
  const readStories = input.readStories ?? readPrdStories;
  const derive = input.derive ?? deriveStoryPhases;
  const fetchTimeoutMs = resolveFetchTimeoutMs(input.storyFetchTimeoutMs);
  const gitTimeoutMs = input.gitTimeoutMs ?? DEFAULT_STORY_PHASE_GIT_TIMEOUT_MS;
  const log = input.log ?? (() => {});

  const snapshot = (): StoryPhaseSnapshot | undefined => {
    const stories = readStories(input.prdIndex);
    if (stories === undefined) return undefined;

    let derived: Readonly<Record<string, StoryPhase>> = {};
    try {
      derived = derive({
        repoDir: input.repoDir,
        storyIds: stories.map((story) => story.id),
        mainBranch,
        ...(input.storyIdPattern !== undefined ? { storyIdPattern: input.storyIdPattern } : {}),
        gitTimeoutMs,
      });
    } catch {
      // no-excuse-ok: catch -- derive must never throw out of the resolver
      derived = {};
    }

    const phases: Record<string, StoryPhase> = {};
    for (const story of stories) {
      const stored = input.storyState.readPhase(story.id) ?? "building";
      const derivedPhase = derived[story.id];
      if (derivedPhase !== undefined && comparePhase(derivedPhase, stored) > 0) {
        input.storyState.writePhase(story.id, derivedPhase);
        log(`[looper] story ${story.id}: phase ${derivedPhase} (derived from git)`);
        phases[story.id] = derivedPhase;
      } else {
        phases[story.id] = derivedPhase === undefined ? stored : maxPhase(stored, derivedPhase);
      }
    }
    return { stories, phases, terminal };
  };

  const fetchMain = async (): Promise<void> => {
    await fetchOriginMain(input.repoDir, mainBranch, fetchTimeoutMs);
  };

  return { snapshot, fetchMain };
}
