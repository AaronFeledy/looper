import { describe, expect, test } from "bun:test";

import { createRunControl } from "../src/engine/run-control.ts";

describe("createRunControl", () => {
  test("initial values are all false with undefined restartReason", () => {
    const control = createRunControl();
    expect(control.quitting).toBe(false);
    expect(control.paused).toBe(false);
    expect(control.skipRequested).toBe(false);
    expect(control.restartRequested).toBe(false);
    expect(control.restartReason).toBeUndefined();
    expect(control.stopAfterIteration).toBe(false);
  });

  test("setQuitting flips only quitting", () => {
    const control = createRunControl();
    control.setQuitting(true);
    expect(control.quitting).toBe(true);
    expect(control.paused).toBe(false);
    expect(control.skipRequested).toBe(false);
    expect(control.restartRequested).toBe(false);
    expect(control.restartReason).toBeUndefined();
    expect(control.stopAfterIteration).toBe(false);
  });

  test("setPaused flips only paused", () => {
    const control = createRunControl();
    control.setPaused(true);
    expect(control.paused).toBe(true);
    expect(control.quitting).toBe(false);
    expect(control.skipRequested).toBe(false);
    expect(control.restartRequested).toBe(false);
    expect(control.restartReason).toBeUndefined();
    expect(control.stopAfterIteration).toBe(false);
  });

  test("setSkipRequested flips only skipRequested", () => {
    const control = createRunControl();
    control.setSkipRequested(true);
    expect(control.skipRequested).toBe(true);
    expect(control.quitting).toBe(false);
    expect(control.paused).toBe(false);
    expect(control.restartRequested).toBe(false);
    expect(control.restartReason).toBeUndefined();
    expect(control.stopAfterIteration).toBe(false);
  });

  test("setRestartRequested flips only restartRequested", () => {
    const control = createRunControl();
    control.setRestartRequested(true);
    expect(control.restartRequested).toBe(true);
    expect(control.quitting).toBe(false);
    expect(control.paused).toBe(false);
    expect(control.skipRequested).toBe(false);
    expect(control.restartReason).toBeUndefined();
    expect(control.stopAfterIteration).toBe(false);
  });

  test("setRestartReason flips only restartReason", () => {
    const control = createRunControl();
    control.setRestartReason("manual");
    expect(control.restartReason).toBe("manual");
    expect(control.quitting).toBe(false);
    expect(control.paused).toBe(false);
    expect(control.skipRequested).toBe(false);
    expect(control.restartRequested).toBe(false);
    expect(control.stopAfterIteration).toBe(false);
  });

  test("setStopAfterIteration flips only stopAfterIteration", () => {
    const control = createRunControl();
    control.setStopAfterIteration(true);
    expect(control.stopAfterIteration).toBe(true);
    expect(control.quitting).toBe(false);
    expect(control.paused).toBe(false);
    expect(control.skipRequested).toBe(false);
    expect(control.restartRequested).toBe(false);
    expect(control.restartReason).toBeUndefined();
  });

  test('requestRestart("timeout") sets restartRequested and restartReason', () => {
    const control = createRunControl();
    control.requestRestart("timeout");
    expect(control.restartRequested).toBe(true);
    expect(control.restartReason).toBe("timeout");
    expect(control.skipRequested).toBe(false);
    expect(control.quitting).toBe(false);
    expect(control.paused).toBe(false);
    expect(control.stopAfterIteration).toBe(false);
  });

  test("requestSkip sets skipRequested", () => {
    const control = createRunControl();
    control.requestSkip();
    expect(control.skipRequested).toBe(true);
    expect(control.restartRequested).toBe(false);
    expect(control.restartReason).toBeUndefined();
    expect(control.quitting).toBe(false);
    expect(control.paused).toBe(false);
    expect(control.stopAfterIteration).toBe(false);
  });

  test("clearStepRequests clears skip/restart/reason and leaves run flags", () => {
    const control = createRunControl();
    control.setQuitting(true);
    control.setPaused(true);
    control.setStopAfterIteration(true);
    control.requestSkip();
    control.requestRestart("manual");

    control.clearStepRequests();

    expect(control.skipRequested).toBe(false);
    expect(control.restartRequested).toBe(false);
    expect(control.restartReason).toBeUndefined();
    expect(control.quitting).toBe(true);
    expect(control.paused).toBe(true);
    expect(control.stopAfterIteration).toBe(true);
  });

  test("clearRunRequests clears quitting/paused/stopAfterIteration and leaves step flags", () => {
    const control = createRunControl();
    control.setQuitting(true);
    control.setPaused(true);
    control.setStopAfterIteration(true);
    control.requestSkip();
    control.requestRestart("timeout");

    control.clearRunRequests();

    expect(control.quitting).toBe(false);
    expect(control.paused).toBe(false);
    expect(control.stopAfterIteration).toBe(false);
    expect(control.skipRequested).toBe(true);
    expect(control.restartRequested).toBe(true);
    expect(control.restartReason).toBe("timeout");
  });

  test("togglePaused returns the new value both directions", () => {
    const control = createRunControl();
    expect(control.paused).toBe(false);
    expect(control.togglePaused()).toBe(true);
    expect(control.paused).toBe(true);
    expect(control.togglePaused()).toBe(false);
    expect(control.paused).toBe(false);
  });

  test("onChange fires once per mutating call including same-value setters", () => {
    let calls = 0;
    const control = createRunControl({ onChange: () => {
      calls += 1;
    } });

    control.setQuitting(true);
    control.setQuitting(true);
    control.setPaused(false);
    control.setSkipRequested(true);
    control.setRestartRequested(false);
    control.setRestartReason(undefined);
    control.setStopAfterIteration(true);
    control.requestSkip();
    control.requestRestart("manual");
    control.togglePaused();
    control.clearStepRequests();
    control.clearRunRequests();

    expect(calls).toBe(12);
  });

  test("getters never fire onChange", () => {
    let calls = 0;
    const control = createRunControl({ onChange: () => {
      calls += 1;
    } });
    void control.quitting;
    void control.paused;
    void control.skipRequested;
    void control.restartRequested;
    void control.restartReason;
    void control.stopAfterIteration;
    expect(calls).toBe(0);
  });

  test("default-constructed control never throws on mutations", () => {
    const control = createRunControl();
    expect(() => {
      control.setQuitting(true);
      control.setPaused(true);
      control.setSkipRequested(true);
      control.setRestartRequested(true);
      control.setRestartReason("timeout");
      control.setStopAfterIteration(true);
      control.requestSkip();
      control.requestRestart("manual");
      control.togglePaused();
      control.clearStepRequests();
      control.clearRunRequests();
    }).not.toThrow();
  });

  test("getters reflect mutations immediately for poll-style reads", () => {
    const control = createRunControl();
    expect(control.skipRequested).toBe(false);
    control.requestSkip();
    expect(control.skipRequested).toBe(true);
    control.clearStepRequests();
    expect(control.skipRequested).toBe(false);

    expect(control.restartRequested).toBe(false);
    control.requestRestart("timeout");
    expect(control.restartRequested).toBe(true);
    expect(control.restartReason).toBe("timeout");
  });
});
