import type { ScrollAcceleration } from "@opentui/core";

/** OpenTUI receives a delta of roughly three rows for one terminal wheel notch. */
export const WHEEL_SCROLL_SCALE = 1 / 3;

export function createWheelScrollAcceleration(): ScrollAcceleration {
  return {
    tick: () => WHEEL_SCROLL_SCALE,
    reset: () => {},
  };
}
