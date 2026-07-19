import type { BoxRenderable, CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { createTextDialog } from "./dialog.ts";

export function helpLines(): string[] {
  return [
    "g/enter run/resume; on PR: open",
    "q       quit",
    "p       pause between steps",
    "s       skip active step",
    "r       restart in fresh session",
    "e       end after this iteration",
    "esc esc stop; pre-run reset ckpt",
    "ctrl-c  copy/stop; 2x: force kill",
    "h history; L/R iter, U/D step",
    "tab focus: steps / PR / output",
    "up/down select / scroll output",
    "pgup/dn scroll; home/end too",
    "v       view hidden looper prompt",
    "c       view looper config",
    "?       toggle help",
  ];
}

export function createHelpOverlay(renderer: CliRenderer, state: LoopState): BoxRenderable {
  return createTextDialog(renderer, state, {
    id: "loop-help",
    borderColor: "#89b4fa",
    width: "95%",
    maxWidth: 88,
    maxHeight: 18,
    isVisible: (s) => s.helpVisible,
    content: () => ({
      title: "keys",
      body: helpLines().join("\n"),
    }),
  });
}
