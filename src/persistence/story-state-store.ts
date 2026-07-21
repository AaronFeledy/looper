import type { StoryStatePort } from "../engine/engine-ports.ts";
import { clearStoryState, readStoryPhase, writeStoryPhase } from "../lib/story-state-files.ts";
import { initStatePaths } from "../lib/state-files.ts";

export type StoryStateStore = StoryStatePort;

export function createStoryStateStore(opts: { readonly configDir: string }): StoryStateStore {
  initStatePaths({ configDir: opts.configDir });
  return {
    readPhase: readStoryPhase,
    writePhase: writeStoryPhase,
    clear: clearStoryState,
  };
}
