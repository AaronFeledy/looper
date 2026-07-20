import { writeAdjudicateMarker } from "./adjudication-files.ts";
import type { SignalCommand } from "./args.ts";
import { UsageError } from "./args.ts";
import { loadRuntimeConfig } from "./config.ts";
import { currentGitBranch, storyIdFromBranch } from "./story-id.ts";
import { initStatePaths, writeStopAfterIterationFile, writeStopFile } from "./state-files.ts";
import { createStoryStateStore } from "../persistence/story-state-store.ts";

type SignalInput = {
  readonly command: SignalCommand;
  readonly configDir: string;
  readonly repoDir: string;
};

export async function handleSignal(input: SignalInput): Promise<string> {
  initStatePaths({ configDir: input.configDir });

  switch (input.command.kind) {
    case "adjudicate":
      writeAdjudicateMarker(input.command.reason);
      return "Adjudication requested.";
    case "stop":
      writeStopFile(input.command.reason);
      return "Stop requested.";
    case "stop-after-iteration":
      writeStopAfterIterationFile(input.command.reason);
      return "Stop after iteration requested.";
    case "story-phase": {
      let storyId = input.command.story;
      if (storyId === undefined) {
        const branch = await currentGitBranch(input.repoDir);
        let storyIdPattern: string | undefined;
        try {
          storyIdPattern = loadRuntimeConfig(input.configDir, input.repoDir).storyIdPattern;
        } catch (error) {
          if (error instanceof Error) throw new UsageError(`invalid looper config: ${error.message}`);
          throw error;
        }
        storyId = branch === undefined ? undefined : storyIdFromBranch(branch, storyIdPattern);
      }
      if (storyId === undefined) {
        throw new UsageError("could not derive a story ID from the current branch; provide --story <ID>");
      }
      createStoryStateStore({ configDir: input.configDir }).writePhase(storyId, input.command.phase);
      return `Story ${storyId} phase set to ${input.command.phase}.`;
    }
  }
}
