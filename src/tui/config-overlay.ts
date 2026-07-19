import { basename } from "node:path";
import type { BoxRenderable, CliRenderer } from "@opentui/core";

import { readConfigFileSource } from "../lib/config.ts";
import type { LoopState } from "../lib/state.ts";
import { createTextDialog } from "./dialog.ts";

function configModalContent(configDir: string): { title: string; body: string } {
  try {
    const source = readConfigFileSource(configDir);
    if (source === undefined) {
      return {
        title: "looper config",
        body: `No config file found in ${configDir}.`,
      };
    }
    return {
      title: basename(source.path),
      body: source.content.length > 0 ? source.content : "(empty file)",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      title: "looper config",
      body: `Failed to read config:\n${detail}`,
    };
  }
}

export function createConfigOverlay(renderer: CliRenderer, state: LoopState, configDir: string): BoxRenderable {
  return createTextDialog(renderer, state, {
    id: "loop-config",
    borderColor: "#94e2d5",
    width: "80%",
    height: "70%",
    maxWidth: 100,
    maxHeight: 40,
    minHeight: 10,
    isVisible: (s) => s.configModalVisible,
    content: () => configModalContent(configDir),
  });
}
