import { BoxRenderable, RGBA, type OptimizedBuffer } from "@opentui/core";

type RGB = readonly [number, number, number];
export const blendBubbleColor = (from: RGB, to: RGB, amount: number): [number, number, number] =>
  from.map((value, i) => Math.round(value + (to[i]! - value) * amount)) as [number, number, number];

/** A fixed bold ring that breathes through color only. */
export function activityRing(phase: number, animate: boolean) {
  const glow = animate ? (1 - Math.cos(phase)) / 2 : 0.65;
  return { glyph: "◎", glow, bold: true };
}

/** Clockwise highlight with a short soft leading edge and a longer fading wake. */
export function borderChase(position: number, phase: number): number {
  const head = phase / (Math.PI * 2);
  const behind = ((head - position + 0.5) % 1 + 1) % 1 - 0.5;
  return Math.exp(-0.5 * (behind / (behind >= 0 ? 0.16 : 0.045)) ** 2);
}

/** Keeps native box layout/hit testing; only its border cells receive the chase. */
export class AgentBubbleRenderable extends BoxRenderable {
  private chase?: { phase: number; dim: RGB; bright: RGB };

  setChase(value: typeof this.chase): void {
    this.chase = value;
    this.requestRender();
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer);
    if (!this.chase || this.width < 3 || this.height < 3) return;
    const { phase, dim, bright } = this.chase;
    const w = this.width, h = this.height;
    // Terminal cells are roughly twice as tall as they are wide. Measuring the
    // vertical edges in two units keeps the highlight's apparent speed even.
    const perimeter = 2 * (w - 1) + 4 * (h - 1);
    const titleStart = this.bottomTitle ? Math.max(1, w - Bun.stringWidth(this.bottomTitle) - 3) : w;
    const draw = (x: number, y: number, char: string, distance: number) => {
      // Native right-aligned badges stay steady and legible over the bottom edge.
      if (y === h - 1 && x >= titleStart && x < w - 1) return;
      const color = blendBubbleColor(dim, bright, borderChase(distance / perimeter, phase));
      buffer.drawText(char, this.x + x, this.y + y, RGBA.fromInts(...color), this.backgroundColor);
    };
    for (let x = 0; x < w; x++) draw(x, 0, x === 0 ? "╭" : x === w - 1 ? "╮" : "─", x);
    for (let y = 1; y < h; y++) draw(w - 1, y, y === h - 1 ? "╯" : "│", w - 1 + 2 * y);
    for (let x = w - 2; x >= 0; x--) draw(x, h - 1, x === 0 ? "╰" : "─", w - 1 + 2 * (h - 1) + w - 1 - x);
    for (let y = h - 2; y > 0; y--) draw(0, y, "│", 2 * (w - 1) + 2 * (h - 1) + 2 * (h - 1 - y));
  }
}
