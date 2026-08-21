/** Display-width-aware truncation and wrapping for narrow sidebar columns. */

export function displayWidth(value: string): number {
  return Bun.stringWidth(value);
}

export function truncateDisplay(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(value) <= maxWidth) return value;
  const ellipsisWidth = displayWidth("…");
  const targetWidth = Math.max(0, maxWidth - ellipsisWidth);
  let result = "";
  for (const char of value) {
    const next = result + char;
    if (displayWidth(next) > targetWidth) break;
    result = next;
  }
  return `${result}…`;
}

/**
 * Wrap `text` into at most `maxLines` lines of display width `maxWidth`.
 * The last line is ellipsized when more text remains.
 */
export function wrapDisplayLines(text: string, maxWidth: number, maxLines: number): string[] {
  return wrapDisplayLinesToWidths(text, Array.from({ length: maxLines }, () => maxWidth));
}

export function wrapDisplayLinesToWidths(text: string, widths: readonly number[]): string[] {
  if (widths.length === 0 || widths.every((width) => width <= 0)) return [];
  const normalized = text.trim();
  if (normalized.length === 0) return [""];

  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  let wordIndex = 0;

  while (wordIndex < words.length && lines.length < widths.length) {
    const lineWidth = widths[lines.length];
    if (lineWidth === undefined) break;
    if (lineWidth <= 0) {
      lines.push("");
      continue;
    }
    const word = words[wordIndex];
    if (word === undefined) break;
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= lineWidth) {
      current = candidate;
      wordIndex += 1;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
      current = "";
      if (lines.length >= widths.length) {
        let tail = word;
        for (let i = wordIndex + 1; i < words.length; i++) {
          const nextWord = words[i];
          if (nextWord !== undefined) tail += ` ${nextWord}`;
        }
        const lastIndex = widths.length - 1;
        const lastLine = lines[lastIndex];
        if (lastLine !== undefined) lines[lastIndex] = truncateDisplay(`${lastLine} ${tail}`, lineWidth);
        return lines.slice(0, widths.length);
      }
      continue;
    }
    if (displayWidth(word) <= lineWidth) {
      current = word;
      wordIndex += 1;
      continue;
    }
    lines.push(truncateDisplay(word, lineWidth));
    wordIndex += 1;
    if (lines.length >= widths.length) return lines.slice(0, widths.length);
  }

  if (current.length > 0) {
    if (lines.length < widths.length) lines.push(current);
    else {
      const lastIndex = widths.length - 1;
      const lastLine = lines[lastIndex];
      const lastWidth = widths[lastIndex];
      if (lastLine !== undefined && lastWidth !== undefined) lines[lastIndex] = truncateDisplay(`${lastLine} ${current}`, lastWidth);
    }
  }

  const firstWidth = widths[0];
  return lines.length > 0 ? lines.slice(0, widths.length) : firstWidth === undefined ? [] : [truncateDisplay(normalized, firstWidth)];
}
