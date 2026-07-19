/** True when the viewport is at (or has no) bottom — the only re-pin condition. */
export function isAtScrollBottom(scrollTop: number, maxScrollTop: number): boolean {
  return maxScrollTop <= 0 || scrollTop >= maxScrollTop;
}

/** After a user-driven scroll, pin only at the true bottom (one row up unpins). */
export function pinAfterUserScroll(scrollTop: number, maxScrollTop: number): boolean {
  return isAtScrollBottom(scrollTop, maxScrollTop);
}

export const FOLLOW_INDICATOR = "↓";
export const FOLLOW_INDICATOR_INACTIVE = "#6c7086";
export const FOLLOW_INDICATOR_ACTIVE_BRIGHT = "#89b4fa";
export const FOLLOW_INDICATOR_ACTIVE_DIM = "#45475a";

/** Always-visible follow glyph; inactive is grayed via followIndicatorColor. */
export function followBottomTitle(_pinnedToBottom: boolean): string {
  return FOLLOW_INDICATOR;
}

function hexChannel(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpHex(a: string, b: string, t: number): string {
  const r = lerpChannel(hexChannel(a, 0), hexChannel(b, 0), t);
  const g = lerpChannel(hexChannel(a, 1), hexChannel(b, 1), t);
  const bl = lerpChannel(hexChannel(a, 2), hexChannel(b, 2), t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** Inactive: gray. Active: slow cosine pulse between dim and bright blue (~2.4s). */
export function followIndicatorColor(pinnedToBottom: boolean, pulsePhaseMs = 0): string {
  if (!pinnedToBottom) return FOLLOW_INDICATOR_INACTIVE;
  const t = (1 - Math.cos((pulsePhaseMs / 2400) * Math.PI * 2)) / 2;
  return lerpHex(FOLLOW_INDICATOR_ACTIVE_DIM, FOLLOW_INDICATOR_ACTIVE_BRIGHT, t);
}
