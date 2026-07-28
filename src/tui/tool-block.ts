import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";

import { ansiToStyledText } from "../lib/ansi.ts";
import type { OutputBlock } from "../presentation/tui/stream-blocks.ts";
import {
  previewToolOutputLines,
  toolOutputExpandHint,
} from "../presentation/tui/tool-output-preview.ts";

export type ToolOutputBlock = Extract<OutputBlock, { kind: "tool" }>;

export function toolOutputBlockKey(block: ToolOutputBlock): string {
  return `${block.firstSeenAt}\0${block.tool}\0${block.callLine}`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function createTextBlock(renderer: CliRenderer, id: string, lines: readonly string[], color = "#cdd6f4"): TextRenderable {
  return new TextRenderable(renderer, {
    id,
    width: "100%",
    minWidth: 0,
    alignSelf: "stretch",
    wrapMode: "word",
    truncate: false,
    content: ansiToStyledText(lines.join("\n")),
    fg: color,
  });
}

export function createToolBlock(
  renderer: CliRenderer,
  id: string,
  block: ToolOutputBlock,
  options: {
    readonly expanded: boolean;
    readonly onToggleExpand?: () => void;
  },
): BoxRenderable {
  const borderColor = block.status === "waiting" ? "#f9e2af" : block.status === "error" ? "#f38ba8" : "#a6e3a1";
  const statusText = block.status === "waiting" ? "waiting" : block.status === "error" ? "failed" : "done";
  const box = new BoxRenderable(renderer, {
    id,
    width: "100%",
    minWidth: 0,
    alignSelf: "stretch",
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor,
    title: `Tool · ${block.tool} · ${statusText}`,
    titleAlignment: "left",
    bottomTitle: formatTimestamp(block.firstSeenAt),
    bottomTitleAlignment: "right",
    paddingX: 1,
    marginBottom: 1,
  });

  box.add(createTextBlock(renderer, `${id}-call`, [block.callLine], "#f9e2af"));

  if (block.status === "waiting") {
    box.add(createTextBlock(renderer, `${id}-waiting`, ["⏳ waiting for response…"], "#6c7086"));
    return box;
  }

  const fullLines = block.outputLines.length > 0 ? block.outputLines : ["(no output)"];
  const preview = previewToolOutputLines(fullLines);
  const showFull = options.expanded || !preview.truncated;
  const responseLines = showFull ? fullLines : [...preview.lines];
  const responseColor = block.status === "error" ? "#f38ba8" : "#cdd6f4";
  box.add(createTextBlock(renderer, `${id}-response`, responseLines, responseColor));

  if (preview.truncated) {
    const hint = toolOutputExpandHint(preview.hiddenCount, options.expanded);
    const hintText = createTextBlock(renderer, `${id}-expand`, [hint], "#6c7086");
    hintText.selectable = false;
    const toggle = options.onToggleExpand;
    if (toggle !== undefined) {
      const onToggle = (event: { type: string; button: number; stopPropagation: () => void; preventDefault: () => void }): void => {
        if (event.type !== "up" || event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        toggle();
      };
      hintText.onMouseUp = onToggle;
      box.onMouseUp = onToggle;
    }
    box.add(hintText);
  }

  return box;
}
