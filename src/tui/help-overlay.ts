import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";

export function helpLines(): string[] {
  return [
    "g / enter      start or resume the run (enter opens the PR when the PR panel is focused)",
    "q              quit",
    "p              pause (takes effect between steps)",
    "s              skip the active step",
    "r              restart the active step in a fresh session",
    "e              end after the current iteration",
    "esc esc        stop the run (before start: reset a resumable checkpoint)",
    "ctrl-c         copy selected text; otherwise stop after iteration (twice: force kill)",
    "h              toggle history (left/right: iteration, up/down: step)",
    "tab            cycle focus: steps / PR / output",
    "up / down      select step, or scroll output when it has focus",
    "pgup pgdn      scroll output (also home / end)",
    "?              toggle this help",
  ];
}

export function createHelpOverlay(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    id: "loop-help-overlay",
    width: "100%",
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: "#89b4fa",
    title: "keys — press any key to close",
    titleAlignment: "left",
    paddingX: 1,
    marginBottom: 1,
    flexShrink: 0,
    visible: false,
  });

  const text = new TextRenderable(renderer, {
    id: "loop-help-overlay-text",
    width: "100%",
    content: helpLines().join("\n"),
    fg: "#cdd6f4",
    wrapMode: "word",
  });
  box.add(text);

  const apply = (): void => {
    if (box.visible === state.helpVisible) return;
    box.visible = state.helpVisible;
    renderer.requestRender();
  };

  apply();
  const unsubscribe = subscribe(apply);
  box.on(RenderableEvents.DESTROYED, () => {
    unsubscribe();
  });

  return box;
}
