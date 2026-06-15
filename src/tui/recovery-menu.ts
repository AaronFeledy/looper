import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";

function bannerLines(state: LoopState): string[] {
  const recovery = state.recovery;
  if (recovery === null) return [];
  const sessionLine = recovery.sessionID === undefined ? "" : `  (session ${recovery.sessionID})`;
  return [
    `Step "${recovery.stepName}" failed: ${recovery.reason}${sessionLine}`,
    "[r] restart step (fresh session)   [n] nudge (re-prompt to fix & finish)   [q] quit",
  ];
}

export function createRecoveryMenu(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    id: "loop-recovery-menu",
    width: "100%",
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: "#f38ba8",
    title: "recovery",
    titleAlignment: "left",
    paddingX: 1,
    marginBottom: 1,
    flexShrink: 0,
    visible: false,
  });

  const text = new TextRenderable(renderer, {
    id: "loop-recovery-menu-text",
    width: "100%",
    content: "",
    fg: "#f38ba8",
    wrapMode: "word",
  });
  box.add(text);

  const apply = (): void => {
    const lines = bannerLines(state);
    if (lines.length === 0) {
      box.visible = false;
      text.content = "";
    } else {
      text.content = lines.join("\n");
      box.visible = true;
    }
    renderer.requestRender();
  };

  apply();
  const unsubscribe = subscribe(apply);
  box.on(RenderableEvents.DESTROYED, () => {
    unsubscribe();
  });

  return box;
}
