import { clearStoryState, readStoryPhase, writeStoryPhase, type StoryPhase } from "../lib/story-state-files.ts";
import { initStatePaths } from "../lib/state-files.ts";

export type StoryStateStore = {
  readonly readPhase: (storyId: string) => StoryPhase | undefined;
  readonly writePhase: (storyId: string, phase: StoryPhase) => void;
  readonly clear: () => void;
};

export function createStoryStateStore(opts: { readonly configDir: string }): StoryStateStore {
  initStatePaths({ configDir: opts.configDir });
  return {
    readPhase: readStoryPhase,
    writePhase: writeStoryPhase,
    clear: clearStoryState,
  };
}
