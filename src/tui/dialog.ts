import {
  BoxRenderable,
  RenderableEvents,
  RGBA,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { sanitizeTerminalText } from "../lib/ansi.ts";
import { subscribe } from "../lib/state.ts";

const COLOR_DIALOG_BG = "#1e1e2e";
const COLOR_TEXT = "#cdd6f4";
const SCRIM_BG = RGBA.fromInts(17, 17, 27, 180);
const DEFAULT_Z_INDEX = 200;

export type DialogContent = {
  readonly title: string;
  readonly body: string;
};

export type TextDialogOptions = {
  readonly id: string;
  readonly borderColor: string;
  readonly zIndex?: number;
  readonly width?: number | `${number}%`;
  readonly height?: number | `${number}%`;
  readonly maxWidth?: number | `${number}%`;
  readonly maxHeight?: number | `${number}%`;
  readonly minHeight?: number | `${number}%`;
  /** When true (default), body lives in a ScrollBox. Short static dialogs can set false. */
  readonly scroll?: boolean;
  readonly isVisible: (state: LoopState) => boolean;
  readonly content: (state: LoopState) => DialogContent;
};

/**
 * Floating dialog: absolute full-viewport host + translucent scrim + centered panel.
 * OpenTUI has no Modal primitive; this is the shared pattern for help / prompt / config.
 */
export function createTextDialog(
  renderer: CliRenderer,
  state: LoopState,
  options: TextDialogOptions,
): BoxRenderable {
  const zIndex = options.zIndex ?? DEFAULT_Z_INDEX;
  const scroll = options.scroll !== false;

  const host = new BoxRenderable(renderer, {
    id: `${options.id}-host`,
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    visible: false,
  });

  const scrim = new BoxRenderable(renderer, {
    id: `${options.id}-scrim`,
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 0,
    backgroundColor: SCRIM_BG,
  });

  const dialog = new BoxRenderable(renderer, {
    id: `${options.id}-dialog`,
    ...(options.width !== undefined ? { width: options.width } : { width: "80%" }),
    ...(options.height !== undefined ? { height: options.height } : {}),
    ...(options.maxWidth !== undefined ? { maxWidth: options.maxWidth } : {}),
    ...(options.maxHeight !== undefined ? { maxHeight: options.maxHeight } : {}),
    ...(options.minHeight !== undefined ? { minHeight: options.minHeight } : {}),
    zIndex: 1,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: options.borderColor,
    backgroundColor: COLOR_DIALOG_BG,
    title: "",
    titleAlignment: "left",
    paddingX: 1,
  });

  const text = new TextRenderable(renderer, {
    id: `${options.id}-text`,
    width: "100%",
    content: "",
    fg: COLOR_TEXT,
    wrapMode: "word",
  });

  if (scroll) {
    const scrollBox = new ScrollBoxRenderable(renderer, {
      id: `${options.id}-scroll`,
      width: "100%",
      flexGrow: 1,
      minHeight: 0,
      scrollY: true,
      scrollX: false,
      stickyScroll: false,
      contentOptions: {
        flexDirection: "column",
        alignItems: "stretch",
        width: "100%",
        minHeight: "auto",
      },
    });
    scrollBox.add(text);
    dialog.add(scrollBox);
  } else {
    dialog.add(text);
  }

  host.add(scrim);
  host.add(dialog);

  let lastVisible = false;
  let lastTitle = "";
  let lastBody = "";

  const apply = (): void => {
    const visible = options.isVisible(state);
    if (host.visible !== visible) host.visible = visible;

    if (!visible) {
      if (lastVisible) {
        lastVisible = false;
        lastTitle = "";
        lastBody = "";
        renderer.requestRender();
      }
      return;
    }

    const content = options.content(state);
    const title = sanitizeTerminalText(content.title);
    const body = sanitizeTerminalText(content.body);
    if (body !== lastBody) text.content = body;
    if (title !== lastTitle) dialog.title = title;
    if (!lastVisible || body !== lastBody || title !== lastTitle) {
      lastVisible = true;
      lastBody = body;
      lastTitle = title;
      renderer.requestRender();
    }
  };

  apply();
  const unsubscribe = subscribe(apply);
  host.on(RenderableEvents.DESTROYED, () => {
    unsubscribe();
  });

  return host;
}
