import type { BoxRenderable, CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { createTextDialog } from "./dialog.ts";

type HelpBinding = {
  readonly keys: string;
  readonly action: string;
};

const HELP_BINDINGS: readonly HelpBinding[] = [
  { keys: "g, enter", action: "run / resume" },
  { keys: "q", action: "quit" },
  { keys: "p", action: "pause between steps" },
  { keys: "s", action: "skip active step" },
  { keys: "r", action: "restart step" },
  { keys: "t", action: "double timeout" },
  { keys: "e", action: "end this iteration" },
  { keys: "esc esc", action: "stop / reset checkpoint" },
  { keys: "h", action: "history" },
  { keys: "tab", action: "steps / PR / output" },
  { keys: "up down", action: "select / scroll" },
  { keys: "pgup pgdn", action: "page output" },
  { keys: "home end", action: "jump in output" },
  { keys: "v", action: "hidden looper prompt" },
  { keys: "c", action: "looper config" },
  { keys: "l", action: "runtime diagnostics" },
  { keys: "?", action: "this help" },
];

function keyColumnWidth(): number {
  return HELP_BINDINGS.reduce((width, binding) => Math.max(width, binding.keys.length), 0);
}

export function helpLines(): string[] {
  const keysWidth = keyColumnWidth();
  return HELP_BINDINGS.map((binding) => `${binding.keys.padEnd(keysWidth)}  ${binding.action}`);
}

export function createHelpOverlay(renderer: CliRenderer, state: LoopState): BoxRenderable {
  return createTextDialog(renderer, state, {
    id: "loop-help",
    borderColor: "#89b4fa",
    width: 38,
    maxWidth: 38,
    maxHeight: 22,
    scroll: Boolean(state.constellation),
    wrapMode: "none",
    isVisible: (s) => s.helpVisible,
    content: () => ({
      title: "keys",
      body: state.constellation
        ? ["↑↓ / tab     select agent", "double-click open agent inspector", "o, enter     open inspector", "esc          close inspector", "1–4 / tab    inspector section", "b            context / open PR", "m            toggle motion", "i            work plan drawer", "", ...helpLines().map((line) => line.replaceAll("step", "agent").replace("g, enter", "g       "))].join("\n")
        : helpLines().join("\n"),
    }),
  });
}
