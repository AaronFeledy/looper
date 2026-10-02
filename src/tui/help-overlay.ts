import type { BoxRenderable, CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { createTextDialog } from "./dialog.ts";
import { displayWidth } from "./text-layout.ts";

type HelpBinding = {
  readonly keys: string;
  readonly action: string;
};

const HELP_BINDINGS: readonly HelpBinding[] = [
  { keys: "g, enter", action: "run / resume" },
  { keys: "q", action: "quit" },
  { keys: "p", action: "pause between agents" },
  { keys: "s", action: "skip active agent" },
  { keys: "r", action: "restart agent" },
  { keys: "t", action: "double timeout" },
  { keys: "e", action: "end this iteration" },
  { keys: "esc esc", action: "stop / reset checkpoint" },
  { keys: "↑↓ ←→", action: "select agent" },
  { keys: "tab", action: "fold / unfold children" },
  { keys: "o, enter", action: "inspect (esc closes)" },
  { keys: "1-4, tab", action: "inspector section" },
  { keys: "pgup pgdn", action: "scroll inspector / plan" },
  { keys: "b", action: "context / open PR" },
  { keys: "i / m", action: "work plan / motion" },
  { keys: "h / l", action: "history / diagnostics" },
  { keys: "v / c", action: "looper prompt / config" },
  { keys: "?", action: "this help" },
];

function keyColumnWidth(): number {
  return HELP_BINDINGS.reduce((width, binding) => Math.max(width, displayWidth(binding.keys)), 0);
}

export function helpLines(): string[] {
  const keysWidth = keyColumnWidth();
  return HELP_BINDINGS.map((binding) => `${binding.keys}${" ".repeat(keysWidth - displayWidth(binding.keys))}  ${binding.action}`);
}

export function createHelpOverlay(renderer: CliRenderer, state: LoopState): BoxRenderable {
  return createTextDialog(renderer, state, {
    id: "loop-help",
    borderColor: "#89b4fa",
    width: 38,
    maxWidth: 38,
    maxHeight: 22,
    scroll: false,
    wrapMode: "none",
    isVisible: (s) => s.helpVisible,
    content: () => ({
      title: "keys",
      body: helpLines().join("\n"),
    }),
  });
}
