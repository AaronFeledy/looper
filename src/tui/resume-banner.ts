import { BoxRenderable, RenderableEvents, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";
import { sanitizeTerminalText } from "../lib/ansi.ts";
import { subscribe, type LoopState } from "../lib/state.ts";
import { bootResumeStatus } from "../presentation/tui/resume-status.ts";

/** Shared by both terminal presentations; visible even when a different row is selected. */
export function createResumeBanner(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const box = new BoxRenderable(renderer, { id: "loop-resume-banner", width: "100%", flexShrink: 0, flexDirection: "column", paddingX: 1, backgroundColor: "#1b2b35" });
  const title = new TextRenderable(renderer, { id: "loop-resume-title", width: "100%", attributes: TextAttributes.BOLD, wrapMode: "word", content: "" });
  const detail = new TextRenderable(renderer, { id: "loop-resume-detail", width: "100%", fg: "#cdd6f4", wrapMode: "word", content: "" });
  box.add(title); box.add(detail);
  const update = () => {
    const status = bootResumeStatus(state);
    box.visible = status !== undefined && state.historyView === null;
    if (!status) return;
    title.content = sanitizeTerminalText(status.title);
    title.fg = status.color;
    detail.content = sanitizeTerminalText(status.detail);
    renderer.requestRender();
  };
  const unsubscribe = subscribe(update);
  box.on(RenderableEvents.DESTROYED, unsubscribe);
  update();
  return box;
}
