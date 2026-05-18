import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";

function formatElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function headerContent(state: LoopState): string {
  const branch = state.branch || "detached";
  if (!state.started) return `Loop · waiting to start  ·  branch ${branch}`;

  return `Loop · iteration ${state.iteration}/${state.maxIterations}  ·  branch ${branch}  ·  ${formatElapsed(
    state.iterationStartedAt,
  )}`;
}

export function createHeader(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const header = new BoxRenderable(renderer, {
    id: "loop-header",
    width: "100%",
    height: 1,
    flexDirection: "row",
  });

  let lastContent = headerContent(state);
  const text = new TextRenderable(renderer, {
    id: "loop-header-text",
    width: "100%",
    height: 1,
    content: lastContent,
    fg: "#8bd5ff",
    truncate: true,
  });

  header.add(text);

  const update = () => {
    const nextContent = headerContent(state);
    if (lastContent === nextContent) return;
    lastContent = nextContent;
    text.content = nextContent;
    renderer.requestRender();
  };

  const unsubscribe = subscribe(update);
  const timer = setInterval(() => {
    if (state.started) update();
  }, 1_000);

  header.on(RenderableEvents.DESTROYED, () => {
    clearInterval(timer);
    unsubscribe();
  });

  return header;
}
