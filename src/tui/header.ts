import { BoxRenderable, dim, fg, RenderableEvents, t, TextRenderable, type CliRenderer, type StyledText } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";

export const SERVER_BADGE_ID = "loop-header-badge";

const BADGE_DOT_COLOR = "#a6e3a1";

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
  if (!state.started) return `Looper · waiting to start  ·  branch ${branch}`;

  return `Looper · iteration ${state.iteration}/${state.maxIterations}  ·  branch ${branch}  ·  ${formatElapsed(
    state.iterationStartedAt,
  )}`;
}

export function buildServerBadge(version: string): StyledText {
  return t`${fg(BADGE_DOT_COLOR)("●")}${dim(` OpenCode v${version}`)}`;
}

export function createHeader(renderer: CliRenderer, state: LoopState, serverVersion?: string): BoxRenderable {
  const header = new BoxRenderable(renderer, {
    id: "loop-header",
    width: "100%",
    height: 1,
    flexDirection: "row",
  });

  let lastContent = headerContent(state);
  const text = new TextRenderable(renderer, {
    id: "loop-header-text",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    height: 1,
    content: lastContent,
    fg: "#8bd5ff",
    truncate: true,
  });

  header.add(text);

  if (serverVersion !== undefined) {
    const badge = new TextRenderable(renderer, {
      id: SERVER_BADGE_ID,
      flexShrink: 0,
      height: 1,
      marginRight: 1,
      content: buildServerBadge(serverVersion),
    });
    header.add(badge);
  }

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
