import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { runIteration } from "../src/lib/orchestrator.ts";
import { bindKeys, type KeyHooks } from "../src/tui/keys.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, type LoopState, type RecoveryChoice } from "../src/lib/state.ts";

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function writeIdleContinuationRecord(repoDir: string, sessionID: string): void {
  const dir = join(repoDir, ".omo", "run-continuation");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${sessionID}.json`),
    JSON.stringify({ sessionID, updatedAt: now, sources: { "background-task": { state: "idle", updatedAt: now } } }),
  );
}

function makeSuccessClient(repoDir: string): { client: OpencodeClient; promptTexts: string[] } {
  const promptTexts: string[] = [];
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_run" } }),
      prompt: async (params: { sessionID: string; parts: { type: string; text: string }[] }) => {
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        writeIdleContinuationRecord(repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { ses_run: { type: "idle" } } }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
    event: {
      subscribe: async (_params: unknown, options: { signal: AbortSignal }) => ({
        stream: (async function* (): AsyncGenerator<never> {
          await waitForAbort(options.signal);
        })(),
      }),
    },
  } as unknown as OpencodeClient;
  return { client, promptTexts };
}

describe("recoveryNudge prompt injection", () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  function setup(): { repoDir: string; configDir: string; state: LoopState } {
    scratch = mkdtempSync(join(tmpdir(), "looper-recovery-"));
    const configDir = join(scratch, ".local", "looper");
    mkdirSync(configDir, { recursive: true });
    initStatePaths({ configDir });
    writeFileSync(join(configDir, "build.md"), "build from scratch\n");
    writeFileSync(join(configDir, "looper.yaml"), "steps:\n  build:\n    prompt: build.md\n    timeout: 1h\n");
    return { repoDir: scratch, configDir, state: createLoopState({ maxIterations: 1, stepNames: ["Build"] }) };
  }

  test("recoveryNudge=true prepends the nudge note to the first step prompt", async () => {
    const { repoDir, configDir, state } = setup();
    const stub = makeSuccessClient(repoDir);

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, recoveryNudge: true });

    expect(result).toBe("complete");
    expect(stub.promptTexts[0]).toContain("resuming after the previous attempt");
    expect(stub.promptTexts[0]).toContain("build from scratch\n");
  });

  test("without recoveryNudge the first step prompt is the plain step prompt", async () => {
    const { repoDir, configDir, state } = setup();
    const stub = makeSuccessClient(repoDir);

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(stub.promptTexts[0]).toBe("build from scratch\n");
    expect(stub.promptTexts[0]).not.toContain("resuming after the previous attempt");
  });
});

type KeyEventLike = { name?: string; ctrl?: boolean; sequence?: string; raw?: string; preventDefault?: () => void };

function fakeRenderer(): { renderer: { keyInput: { on: (e: string, h: (k: KeyEventLike) => void) => void; off: () => void } }; press: (k: KeyEventLike) => void } {
  const handlers: ((k: KeyEventLike) => void)[] = [];
  return {
    renderer: { keyInput: { on: (_e, h) => handlers.push(h), off: () => {} } },
    press: (k) => handlers.forEach((h) => h(k)),
  };
}

function recordingHooks(): { hooks: KeyHooks; calls: string[] } {
  const calls: string[] = [];
  const hooks: KeyHooks = {
    onEscape: () => calls.push("escape"),
    onInterrupt: () => calls.push("interrupt"),
    onQuit: () => calls.push("quit"),
    onRecoveryChoice: (choice: RecoveryChoice) => calls.push(`recovery:${choice}`),
    onRestart: () => calls.push("restart"),
    onSkip: () => calls.push("skip"),
    onStart: () => calls.push("start"),
    onStopAfterIteration: () => calls.push("stop-after"),
    onTogglePause: () => calls.push("pause"),
  };
  return { hooks, calls };
}

describe("keys recovery interception", () => {
  test("while recovery is active, r/n/q map to recovery choices (not normal actions)", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    state.activeStepIndex = 0;
    state.recovery = { stepName: "Build", reason: "boom" };
    const fake = fakeRenderer();
    const { hooks, calls } = recordingHooks();
    bindKeys(fake.renderer as never, state, hooks);

    fake.press({ name: "r" });
    fake.press({ name: "n" });
    fake.press({ name: "q" });

    expect(calls).toEqual(["recovery:restart", "recovery:nudge", "recovery:quit"]);
  });

  test("when recovery is null, r falls through to the normal restart action", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    state.activeStepIndex = 0;
    state.recovery = null;
    const fake = fakeRenderer();
    const { hooks, calls } = recordingHooks();
    bindKeys(fake.renderer as never, state, hooks);

    fake.press({ name: "r" });

    expect(calls).toEqual(["restart"]);
    expect(calls).not.toContain("recovery:restart");
  });

  test("while recovery is active, g/enter are swallowed (do not call onStart)", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    state.activeStepIndex = 0;
    state.recovery = { stepName: "Build", reason: "boom" };
    const fake = fakeRenderer();
    const { hooks, calls } = recordingHooks();
    bindKeys(fake.renderer as never, state, hooks);

    fake.press({ name: "g" });
    fake.press({ name: "enter" });
    fake.press({ name: "return" });

    expect(calls).toEqual([]);
    expect(calls).not.toContain("start");
  });
});

describe("keys escape gesture", () => {
  test("escape routes to onEscape without dismissing the pending confirm", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    state.escConfirm = "stop";
    const fake = fakeRenderer();
    const { hooks, calls } = recordingHooks();
    bindKeys(fake.renderer as never, state, hooks);

    fake.press({ name: "escape" });

    expect(calls).toEqual(["escape"]);
    expect(state.escConfirm).toBe("stop");
  });

  test("any other key cancels a pending esc confirmation and still runs its action", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    state.started = false;
    state.resumable = true;
    state.escConfirm = "reset";
    const fake = fakeRenderer();
    const { hooks, calls } = recordingHooks();
    bindKeys(fake.renderer as never, state, hooks);

    fake.press({ name: "g" });

    expect(state.escConfirm).toBeNull();
    expect(calls).toEqual(["start"]);
  });
});

function selectionRenderer(selectedText: string): {
  renderer: unknown;
  press: (k: KeyEventLike) => void;
  copied: string[];
  clearedCount: () => number;
} {
  const handlers: ((k: KeyEventLike) => void)[] = [];
  const copied: string[] = [];
  let cleared = 0;
  const renderer = {
    keyInput: { on: (_e: string, h: (k: KeyEventLike) => void) => handlers.push(h), off: () => {} },
    getSelection: () => (selectedText.length > 0 ? { getSelectedText: () => selectedText } : null),
    copyToClipboardOSC52: (text: string) => {
      copied.push(text);
      return true;
    },
    clearSelection: () => {
      cleared += 1;
    },
  };
  return { renderer, press: (k) => handlers.forEach((h) => h(k)), copied, clearedCount: () => cleared };
}

describe("keys ctrl+c", () => {
  test("with a selection, ctrl+c copies the text and does not interrupt", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const fake = selectionRenderer("hello world");
    const { hooks, calls } = recordingHooks();
    bindKeys(fake.renderer as never, state, hooks);

    fake.press({ ctrl: true, name: "c" });

    expect(fake.copied).toEqual(["hello world"]);
    expect(fake.clearedCount()).toBe(1);
    expect(calls).not.toContain("interrupt");
  });

  test("with no selection, ctrl+c interrupts", () => {
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const fake = selectionRenderer("");
    const { hooks, calls } = recordingHooks();
    bindKeys(fake.renderer as never, state, hooks);

    fake.press({ ctrl: true, name: "c" });

    expect(fake.copied).toEqual([]);
    expect(calls).toEqual(["interrupt"]);
  });
});
