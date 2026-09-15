import { RGBA, ScrollBoxRenderable, type OptimizedBuffer, type RenderContext, type ScrollBoxOptions } from "@opentui/core";
import { constellationReducedMotion } from "../config/tunables.ts";
import type { LoopState } from "../lib/state.ts";

const ARROW_COLOR = RGBA.fromHex("#91bfc7");
const PULSE_DURATION_MS = 1600;
type ArrowAppearance = { visible: boolean; appearedAt?: number };
type ArrowScrollBoxOptions = ScrollBoxOptions & { motionState?: Pick<LoopState, "constellation"> };

/** Constellation side-column scrolling with centered, fixed overflow hints. */
export class ArrowScrollBoxRenderable extends ScrollBoxRenderable {
  private readonly motionState?: Pick<LoopState, "constellation">;
  private readonly up: ArrowAppearance = { visible: false };
  private readonly down: ArrowAppearance = { visible: false };
  private pulseTimer?: ReturnType<typeof setInterval>;

  constructor(ctx: RenderContext, { motionState, ...options }: ArrowScrollBoxOptions) {
    const bordered = Boolean(options.border);
    super(ctx, {
      ...options,
      // Reserve top/bottom hint rows so scrolling content cannot cover them.
      wrapperOptions: { ...options.wrapperOptions, ...(!bordered ? { marginTop: 1, marginBottom: 1 } : {}) },
    });
    this.motionState = motionState;
    // Constructor visible:false does not set ScrollBar's manual-visibility
    // flag. Use its setter after construction so later overflow stays hidden.
    this.verticalScrollBar.visible = false;
    this.horizontalScrollBar.visible = false;
  }

  private reducedMotion(): boolean {
    return this.motionState?.constellation?.reducedMotion ?? constellationReducedMotion();
  }

  private stopPulse(): void {
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    this.pulseTimer = undefined;
  }

  private arrowColor(arrow: ArrowAppearance, visible: boolean, now: number): RGBA {
    if (visible && !arrow.visible && !this.reducedMotion()) arrow.appearedAt = now;
    arrow.visible = visible;
    if (!visible || this.reducedMotion()) arrow.appearedAt = undefined;
    if (arrow.appearedAt === undefined) return ARROW_COLOR;
    const elapsed = now - arrow.appearedAt;
    if (elapsed >= PULSE_DURATION_MS) {
      arrow.appearedAt = undefined;
      return ARROW_COLOR;
    }
    // Two smooth brightening pulses, returning exactly to the resting color.
    const glow = (1 - Math.cos(elapsed / PULSE_DURATION_MS * Math.PI * 4)) / 2;
    return RGBA.fromInts(
      Math.round(145 + 78 * glow), Math.round(191 + 53 * glow), Math.round(199 + 46 * glow),
    );
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer);
    const fits = this.width >= 3 && this.height >= 2 && this.viewport.height > 0;
    const maxTop = Math.max(0, this.scrollHeight - this.viewport.height);
    const top = Math.max(0, this.scrollTop);
    const now = Date.now();
    const upColor = this.arrowColor(this.up, fits && top > 0, now);
    const downColor = this.arrowColor(this.down, fits && top < maxTop, now);
    const x = this.x + Math.floor((this.width - 1) / 2);
    if (this.up.visible) buffer.drawText("▲", x, this.y, upColor, this.backgroundColor);
    if (this.down.visible) buffer.drawText("▼", x, this.y + this.height - 1, downColor, this.backgroundColor);
    if (this.up.appearedAt === undefined && this.down.appearedAt === undefined) {
      this.stopPulse();
    } else if (!this.pulseTimer) {
      this.pulseTimer = setInterval(() => {
        // Hidden panes should not keep the renderer awake.
        for (let parent = this.parent; parent; parent = parent.parent) {
          if (!parent.visible) { this.stopPulse(); return; }
        }
        if (!this.visible || this.isDestroyed) { this.stopPulse(); return; }
        this.requestRender();
        const latest = Math.max(this.up.appearedAt ?? 0, this.down.appearedAt ?? 0);
        if (this.reducedMotion() || Date.now() - latest >= PULSE_DURATION_MS) this.stopPulse();
      }, 40);
      this.pulseTimer.unref();
    }
  }

  protected override destroySelf(): void {
    this.stopPulse();
    super.destroySelf();
  }
}
