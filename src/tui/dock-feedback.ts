import type { DockPanel } from "../presentation/tui/constellation-dock.ts";
export const DOCK_PULSE_MS = 1600;
const tones = {
  activity: [145, 217, 223],
  success: [166, 227, 161],
  attention: [249, 226, 175],
  failure: [243, 139, 168],
} as const;
const mix = (from: readonly number[], to: readonly number[], amount: number) =>
  "#" + from.map((value, i) => Math.round(value + (to[i]! - value) * amount).toString(16).padStart(2, "0")).join("");

/** No timers of its own: the view's animation loop paints two fading color pulses. */
export function createDockFeedback() {
  const states = new Map<DockPanel["id"], { key: string; started?: number }>();
  return {
    sample(panel: DockPanel, now: number, motion: boolean) {
      let state = states.get(panel.id);
      if (!state) { state = { key: "" }; states.set(panel.id, state); }
      if (state.key !== panel.key) {
        state.key = panel.key;
        state.started = panel.active && motion ? now : undefined;
      }
      if (!panel.active || !motion || (state.started !== undefined && now - state.started >= DOCK_PULSE_MS)) state.started = undefined;
      if (!panel.active) return { border: "#293744", text: "#536374" };
      const elapsed = state.started === undefined ? undefined : Math.max(0, now - state.started);
      const flash = elapsed === undefined ? 0 : Math.sin(Math.PI * elapsed / 800) ** 2 * (1 - 0.25 * elapsed / DOCK_PULSE_MS);
      const breathing = panel.continuous && motion ? (1 - Math.cos(now / 420)) / 2 : 0;
      const glow = Math.max(flash, breathing * 0.7);
      const accent = tones[panel.tone];
      return {
        border: mix([53, 70, 87], accent, 0.58 + glow * 0.42),
        text: mix(accent, [240, 248, 255], flash * 0.75),
      };
    },
    isPulsing(now: number) {
      return [...states.values()].some(state => state.started !== undefined && now - state.started < DOCK_PULSE_MS);
    },
  };
}
