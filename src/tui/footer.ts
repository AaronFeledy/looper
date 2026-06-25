import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";

function footerContent(state: LoopState): string {
  if (state.escConfirm === "reset") {
    return `Press [esc] again to reset to a fresh run  ·  any other key cancels`;
  }
  if (state.escConfirm === "stop") {
    return `Press [esc] again to stop the run  ·  any other key cancels`;
  }
  if (state.recovery !== null) {
    return `step failed — [r]estart  [n]udge  [q]uit`;
  }
  if (state.historyView !== null) {
    const navHint = state.focusedPane === "steps" ? "Up/Down: step" : "Up/Down/PageUp/PageDown/Home/End: scroll";
    return `[h] exit history  Left/Right: iteration  Tab: ${state.focusedPane === "steps" ? "output" : "steps"}  ${navHint}  [q]uit`;
  }
  if (!state.started) {
    const reset = state.resumable ? "  [esc] reset" : "";
    return `[q]uit  [g]o/start  [e]nd after iteration  [h]istory${reset}  Up/Down: select step`;
  }

  const focusHint =
    state.focusedPane === "steps"
      ? "Tab: next pane  Up/Down: select"
      : state.focusedPane === "github"
        ? "Tab: next pane  Enter: open PR"
        : "Tab: next pane  Up/Down/PageUp/PageDown/Home/End: scroll";

  const pause = state.paused ? "[p]aused — press p to resume" : "[p]ause";
  const end = state.stopAfterIteration ? "ending after iteration" : "[e]nd after iteration";
  const restart = state.restartRequested ? "restarting step" : "[r]estart step";
  const skip = state.skipRequested ? "skipping step" : "[s]kip step";
  const history = state.history.length > 0 ? "  [h]istory" : "";
  return `[q]uit  ${pause}  ${skip}  ${restart}  ${end}  [esc] stop${history}  ${focusHint}`;
}

function footerColor(state: LoopState): string {
  if (state.escConfirm !== null) return "#f38ba8";
  if (state.recovery !== null) return "#f38ba8";
  if (state.historyView !== null) return "#cba6f7";
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
