import { writeAdjudicateMarker } from "./adjudication-files.ts";
import type { SignalCommand } from "./args.ts";
import { UsageError } from "./args.ts";
import { DEFAULT_MAIN_BRANCH, DEFAULT_TERMINAL_PHASE, loadRuntimeConfig } from "./config.ts";
import { prdIndexPath, readPrdStories } from "./prd.ts";
import { appendSignal, type SignalLogKind } from "./signal-log.ts";
import { currentGitBranch, storyIdFromBranch } from "./story-id.ts";
import { initStatePaths, writeStopAfterIterationFile, writeStopFile } from "./state-files.ts";
import { type StoryPhase } from "./story-state-files.ts";
import { createStoryStateStore } from "../persistence/story-state-store.ts";
import { assertStoryPhasePreconditions } from "./signal-story-phase.ts";

type SignalInput = {
  readonly command: SignalCommand;
  readonly configDir: string;
  readonly repoDir: string;
};

type SignalRuntime = {
  readonly mainBranch: string;
  readonly prdDir?: string;
  readonly storyIdPattern?: string;
  readonly terminalPhase: StoryPhase;
  readonly storyIds?: readonly string[];
};

function loadSignalRuntime(configDir: string, repoDir: string): SignalRuntime {
  try {
    const config = loadRuntimeConfig(configDir, repoDir);
    const stories = config.prdDir === undefined ? undefined : readPrdStories(prdIndexPath(config.prdDir));
    const storyIds = stories === undefined ? undefined : stories.map((story) => story.id);
    return {
      mainBranch: config.mainBranch,
      ...(config.prdDir !== undefined ? { prdDir: config.prdDir } : {}),
      ...(config.storyIdPattern !== undefined ? { storyIdPattern: config.storyIdPattern } : {}),
      terminalPhase: config.terminalPhase,
      ...(storyIds !== undefined ? { storyIds } : {}),
    };
  } catch (error) {
    // Missing or invalid config: defaults for preconditions; story-id derivation still needs a pattern.
    if (error instanceof Error && error.message.startsWith("missing ")) {
      return { mainBranch: DEFAULT_MAIN_BRANCH, terminalPhase: DEFAULT_TERMINAL_PHASE };
    }
    if (error instanceof Error) throw new UsageError(`invalid looper config: ${error.message}`);
    throw error;
  }
}

async function deriveOptionalStoryId(
  repoDir: string,
  runtime: SignalRuntime,
  explicit: string | undefined,
): Promise<string | undefined> {
  if (explicit !== undefined) return explicit;
  const branch = await currentGitBranch(repoDir);
  if (branch === undefined) return undefined;
  return storyIdFromBranch(branch, runtime.storyIdPattern, runtime.storyIds);
}

async function requireStoryId(
  repoDir: string,
  runtime: SignalRuntime,
  explicit: string | undefined,
): Promise<string> {
  const storyId = await deriveOptionalStoryId(repoDir, runtime, explicit);
  if (storyId === undefined) {
    throw new UsageError("could not derive a story ID from the current branch; provide --story <ID>");
  }
  return storyId;
}

function logSignal(
  configDir: string,
  kind: SignalLogKind,
  fields: { storyId?: string; phase?: StoryPhase; reason?: string },
): void {
  appendSignal(configDir, {
    kind,
    ...(fields.storyId !== undefined ? { storyId: fields.storyId } : {}),
    ...(fields.phase !== undefined ? { phase: fields.phase } : {}),
    ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
  });
}

export async function handleSignal(input: SignalInput): Promise<string> {
  initStatePaths({ configDir: input.configDir });
  const runtime = loadSignalRuntime(input.configDir, input.repoDir);

  switch (input.command.kind) {
    case "adjudicate":
      writeAdjudicateMarker(input.command.reason);
      logSignal(input.configDir, "adjudicate", { reason: input.command.reason });
      return "Adjudication requested.";
    case "stop":
      writeStopFile(input.command.reason);
      logSignal(input.configDir, "stop", { reason: input.command.reason });
      return "Stop requested.";
    case "stop-after-iteration":
      writeStopAfterIterationFile(input.command.reason);
      logSignal(input.configDir, "stop-after-iteration", { reason: input.command.reason });
      return "Stop after iteration requested.";
    case "blocked": {
      const storyId = await deriveOptionalStoryId(input.repoDir, runtime, input.command.story);
      logSignal(input.configDir, "blocked", {
        reason: input.command.reason,
        ...(storyId !== undefined ? { storyId } : {}),
      });
      return storyId === undefined
        ? `Blocked recorded (no story): ${input.command.reason}`
        : `Blocked recorded for ${storyId}: ${input.command.reason}`;
    }
    case "no-op": {
      const storyId = await deriveOptionalStoryId(input.repoDir, runtime, input.command.story);
      logSignal(input.configDir, "no-op", {
        reason: input.command.reason,
        ...(storyId !== undefined ? { storyId } : {}),
      });
      return storyId === undefined
        ? `No-op recorded (no story): ${input.command.reason}`
        : `No-op recorded for ${storyId}: ${input.command.reason}`;
    }
    case "story-phase": {
      const storyId = await requireStoryId(input.repoDir, runtime, input.command.story);
      await assertStoryPhasePreconditions(input.repoDir, storyId, input.command.phase, runtime);
      createStoryStateStore({ configDir: input.configDir }).writePhase(storyId, input.command.phase);
      logSignal(input.configDir, "story-phase", {
        storyId,
        phase: input.command.phase,
        ...(input.command.reason !== undefined ? { reason: input.command.reason } : {}),
      });
      return `Story ${storyId} phase set to ${input.command.phase}.`;
    }
  }
}
