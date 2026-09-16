import { afterEach, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createLoopState, cancelPendingNotify, notify } from "../src/lib/state.ts";
import { diagnosticsFor, DIAGNOSTIC_LIMIT, recordDiagnostic, setDiagnosticsVisible } from "../src/lib/tui-diagnostics.ts";
import { createDiagnosticsView } from "../src/tui/diagnostics.ts";
import { createFooter } from "../src/tui/footer.ts";
import { bindKeys, type KeyHooks } from "../src/tui/keys.ts";
import { modalFocusWinner } from "../src/tui/permission-gate.ts";

afterEach(cancelPendingNotify);
test("diagnostics keep bounded, sanitized entries, group repeated errors, and count unseen problems", () => {
  const state = createLoopState({maxIterations: 1, stepNames: ["Build"]});
  recordDiagnostic(state, "error", "console.error", "\x1b[2Jbad\x07 failure");
  recordDiagnostic(state, "error", "console.error", "\x1b[2Jbad\x07 failure");
  expect(diagnosticsFor(state).entries[0]!.message).toBe("bad failure");
  expect(diagnosticsFor(state).entries[0]!.count).toBe(2);
  expect(diagnosticsFor(state).unread).toBe(2);
  setDiagnosticsVisible(state, true);
  expect(diagnosticsFor(state).unread).toBe(0);
  for (let i = 0; i < 220; i++) recordDiagnostic(state, "info", "test", `entry ${i}`);
  expect(diagnosticsFor(state).entries).toHaveLength(DIAGNOSTIC_LIMIT);
  expect(diagnosticsFor(state).dropped).toBe(21);
  recordDiagnostic(state, "error", "stderr", "x".repeat(100_000));
  expect(diagnosticsFor(state).entries.at(-1)!.message.length).toBeLessThan(8100);
});

test("real runtime warnings, console errors and stderr are captured and console output is restored", async () => {
  const code = `
    import { createTestRenderer } from "@opentui/core/testing";
    import { createLoopState, cancelPendingNotify } from "./src/lib/state.ts";
    import { captureTuiDiagnostics } from "./src/lib/tui-diagnostics.ts";
    const setup = await createTestRenderer({width: 50, height: 20});
    const state = createLoopState({maxIterations: 1, stepNames: ["Build"]});
    const stderrWrite = process.stderr.write, consoleError = console.error;
    const stop = captureTuiDiagnostics(state);
    process.emitWarning("warning in the TUI", "MaxListenersExceededWarning");
    console.error(new Error("captured stack"));
    process.stderr.write(Buffer.from("raw stderr diagnostic\\n"), () => {});
    console.log("console informational message");
    await Bun.sleep(100);
    stop(); stop();
    const restored = process.stderr.write === stderrWrite && console.error === consoleError;
    setup.renderer.destroy(); cancelPendingNotify();
    process.stdout.write(JSON.stringify({restored, entries: state.diagnostics?.entries}));
  `;
  const child = Bun.spawn([process.execPath, "-e", code], {cwd: process.cwd(), stdout: "pipe", stderr: "pipe"});
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(status).toBe(0); expect(stderr).toBe("");
  const result = JSON.parse(stdout);
  expect(result.restored).toBe(true);
  const messages = result.entries.map((entry: {message: string}) => entry.message).join("\n");
  expect(messages).toContain("warning in the TUI");
  expect(messages).toContain("Error: captured stack");
  expect(messages).toContain("raw stderr diagnostic");
  expect(messages).toContain("console informational message");
});

for (const constellation of [false, true]) test(`diagnostics open, scroll and close without taking permission input (${constellation ? "constellation" : "classic"})`, async () => {
  const state = createLoopState({maxIterations: 1, stepNames: ["Build"]});
  if (constellation) state.constellation = {detailsOpen: false, reducedMotion: true};
  const setup = await createTestRenderer({width: 90, height: 24});
  const root = new BoxRenderable(setup.renderer, {width: "100%", height: "100%", flexDirection: "column"});
  root.add(createDiagnosticsView(setup.renderer, state)); root.add(createFooter(setup.renderer, state));
  setup.renderer.root.add(root);
  let interrupted = 0;
  const hooks: KeyHooks = {onEscape() {interrupted++;}, onInterrupt() {interrupted++;}, onQuit() {}, onRecoveryChoice() {}, onRestart() {}, onSkip() {}, onStart() {}, onStopAfterIteration() {}, onTogglePause() {}};
  const unbind = bindKeys(setup.renderer, state, hooks);
  try {
    recordDiagnostic(state, "error", "test", "First runtime error\n" + Array.from({length: 45}, (_, i) => `stack detail ${i}`).join("\n"));
    await Bun.sleep(50); await setup.flush();
    expect(setup.captureCharFrame()).toContain("[l] ! 1 new");
    setup.mockInput.pressKey("l"); await Bun.sleep(50); await setup.flush();
    expect(modalFocusWinner(state)).toBe("diagnostics");
    expect(setup.captureCharFrame()).toContain("First runtime error");
    expect(state.diagnostics!.unread).toBe(0);
    setup.mockInput.pressKey("END"); await setup.flush();
    expect(setup.captureCharFrame()).toContain("stack detail 44");
    setup.mockInput.pressKey("ESCAPE"); await Bun.sleep(80); await setup.flush();
    expect(state.diagnostics!.visible).toBe(false); expect(interrupted).toBe(0);
    const link = root.findDescendantById("loop-footer-diagnostics")!;
    await setup.mockMouse.click(link.x + 2, link.y, 0, {delayMs: 0}); await Bun.sleep(50); await setup.flush();
    expect(state.diagnostics!.visible).toBe(true);
    state.pendingRequests = [{kind: "permission", sessionID: "ses_gate", requestID: "ask", generation: 1, permission: "bash", patterns: [], status: "open"}];
    notify(); await Bun.sleep(50); await setup.flush();
    expect(modalFocusWinner(state)).toBe("permission");
    expect(root.findDescendantById("loop-diagnostics-host")!.visible).toBe(false);
    setup.mockInput.pressKey("l"); await setup.flush();
    expect(modalFocusWinner(state)).toBe("permission");
  } finally { unbind(); setup.renderer.destroy(); }
});
