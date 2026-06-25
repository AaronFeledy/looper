/** Display-width-aware truncation and wrapping for narrow sidebar columns. */

export function charDisplayWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint === 0x200d) return 0;
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0;
  if (codePoint >= 0x300 && codePoint <= 0x36f) return 0;
  if (codePoint >= 0x1ab0 && codePoint <= 0x1aff) return 0;
  if (codePoint >= 0x1dc0 && codePoint <= 0x1dff) return 0;
  if (codePoint >= 0x20d0 && codePoint <= 0x20ff) return 0;
  if (codePoint >= 0xfe20 && codePoint <= 0xfe2f) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += charDisplayWidth(char);
  return width;
}

export function truncateDisplay(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(value) <= maxWidth) return value;
  const ellipsisWidth = displayWidth("…");
  const targetWidth = Math.max(0, maxWidth - ellipsisWidth);
  let result = "";
  let width = 0;
  for (const char of value) {
    const charWidth = charDisplayWidth(char);
    if (width + charWidth > targetWidth) break;
    result += char;
    width += charWidth;
  }
  return `${result}…`;
}

/**
 * Wrap `text` into at most `maxLines` lines of display width `maxWidth`.
 * The last line is ellipsized when more text remains.
 */
export function wrapDisplayLines(text: string, maxWidth: number, maxLines: number): string[] {
  if (maxLines <= 0 || maxWidth <= 0) return [];
  const normalized = text.trim();
  if (normalized.length === 0) return [""];

  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  let wordIndex = 0;

  while (wordIndex < words.length) {
    const word = words[wordIndex]!;
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= maxWidth) {
      current = candidate;
      wordIndex += 1;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
      current = "";
      if (lines.length >= maxLines) {
        let tail = word;
        for (let i = wordIndex + 1; i < words.length; i++) tail += ` ${words[i]!}`;
        lines[maxLines - 1] = truncateDisplay(`${lines[maxLines - 1]!} ${tail}`, maxWidth);
        return lines.slice(0, maxLines);
      }
      continue;
    }
    if (displayWidth(word) <= maxWidth) {
      current = word;
      wordIndex += 1;
      continue;
    }
    lines.push(truncateDisplay(word, maxWidth));
    wordIndex += 1;
    if (lines.length >= maxLines) return lines.slice(0, maxLines);
  }

  if (current.length > 0) {
    if (lines.length < maxLines) lines.push(current);
    else lines[maxLines - 1] = truncateDisplay(`${lines[maxLines - 1]!} ${current}`, maxWidth);
  }

  return lines.length > 0 ? lines.slice(0, maxLines) : [truncateDisplay(normalized, maxWidth)];
}