import { describe, expect, test } from "bun:test";

import { createWheelScrollAcceleration, WHEEL_SCROLL_SCALE } from "../src/tui/wheel-scroll.ts";

describe("wheel scroll acceleration", () => {
  test("scales a typical three-row wheel delta to one row per notch", () => {
    const acceleration = createWheelScrollAcceleration();

    expect(3 * acceleration.tick()).toBe(1);
    acceleration.reset();
    expect(acceleration.tick()).toBe(WHEEL_SCROLL_SCALE);
  });
});
