import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";

function footerContent(state: LoopState): string {
  if (!state.started) return `[q]uit  [g]o/start  [e]nd after iteration  Up/Down: select first step`;

  const focusHint = state.focusedPane === "steps" ? "Tab: output  Up/Down: select" : "Tab: steps  Up/Down/PageUp/PageDown/Home/End: scroll";

  const pause = state.paused ? "[p]aused — press p to resume" : "[p]ause";
  const end = state.stopAfterIteration ? "ending after iteration" : "[e]nd after iteration";
  const restart = state.restartRequested ? "restarting step" : "[r]estart step";
  const skip = state.skipRequested ? "skipping step" : "[s]kip step";
  return `[q]uit  ${pause}  ${skip}  ${restart}  ${end}  ${focusHint}`;
}

function footerColor(state: LoopState): string {
  return state.paused || state.stopAfterIteration || state.skipRequested || state.restartRequested ? "#f9e2af" : "#6c7086";
}

export function createFooter(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const footer = new BoxRenderable(renderer, {
    id: "loop-footer",
    width: "100%",
    height: 1,
    flexDirection: "row",
  });

  const text = new TextRenderable(renderer, {
    id: "loop-footer-text",
    width: "100%",
    height: 1,
    content: footerContent(state),
    fg: footerColor(state),
    truncate: true,
  });

  footer.add(text);

  const unsubscribe = subscribe(() => {
    text.content = footerContent(state);
    text.fg = footerColor(state);
    renderer.requestRender();
  });

  footer.on(RenderableEvents.DESTROYED, () => {
    unsubscribe();
  });

  return footer;
}
