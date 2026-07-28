export const TOOL_OUTPUT_PREVIEW_LINES = 30;

export type ToolOutputPreview = {
  readonly lines: readonly string[];
  readonly hiddenCount: number;
  readonly truncated: boolean;
};

export function previewToolOutputLines(
  lines: readonly string[],
  maxLines: number = TOOL_OUTPUT_PREVIEW_LINES,
): ToolOutputPreview {
  const limit = Math.max(1, maxLines);
  if (lines.length <= limit) {
    return { lines, hiddenCount: 0, truncated: false };
  }
  return {
    lines: lines.slice(0, limit),
    hiddenCount: lines.length - limit,
    truncated: true,
  };
}

export function toolOutputExpandHint(hiddenCount: number, expanded: boolean): string {
  if (expanded) return "▾ collapse · click to hide full output";
  const noun = hiddenCount === 1 ? "line" : "lines";
  return `▸ ${hiddenCount} more ${noun} · click to expand`;
}
