import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import type { ContextPolicy } from "../src/lib/config.ts";
import { runIteration } from "../src/lib/orchestrator.ts";
import { bindKeys, installBootInterruptHandler, type KeyHooks } from "../src/tui/keys.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, type LoopState, type RecoveryChoice } from "../src/lib/state.ts";

/**
 * This suite asserts on the recoveryNudge prompt's exact plain-text shape,
 * predating the `<looper-context>` block (which defaults on). Disabling it
 * keeps these assertions focused on recoveryNudge behavior instead of also
 * pinning unrelated context-block formatting.
 */
const CONTEXT_OFF: ContextPolicy = { datetime: false, repoDir: false, loopPosition: false, timebox: false, vcsDelta: false, sessionIds: false, prd: false, story: false };

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
    expect(stub.promptTexts[0]).toContain("Continue working to completion if you haven't already.");
    expect(stub.promptTexts[0]).toContain("If the work is already complete, report the result.");
    expect(stub.promptTexts[0]).toContain("build from scratch\n");
  });

  test("without recoveryNudge the first step prompt is the plain step prompt", async () => {
    const { repoDir, configDir, state } = setup();
    const stub = makeSuccessClient(repoDir);

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, contextPolicy: CONTEXT_OFF });

    expect(result).toBe("complete");
    expect(stub.promptTexts[0]).toBe("build from scratch\n");
    expect(stub.promptTexts[0]).not.toContain("Continue working to completion if you haven't already.");
  });

  test("recoveryNudge with an idle resume preserves prompt ownership while nudging the existing session", async () => {
    const { repoDir, configDir, state } = setup();
    const created: string[] = [];
    const prompted: string[] = [];
    const promptTexts: string[] = [];
    const sessionCalls: Array<{ iteration: number; index: number; stepName: string; sessionID: string; messageID: string; promptText?: string; looperMessageIDs?: string[] }> = [];
    const priorPrompt = "exact prior Looper prompt";
    const pluginPrompt = "plugin/server continuation prompt";
    let sentMessageID = "";
    let statusCalls = 0;
    let subscriptions = 0;
    let releasePrompt: (() => void) | undefined;
    const backfilled = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });

    const client = {
      session: {
        create: async () => {
          created.push("ses_new");
          return { data: { id: "ses_new" } };
        },
        prompt: async (params: { sessionID: string; messageID: string; parts: { type: string; text: string }[] }) => {
          prompted.push(params.sessionID);
          sentMessageID = params.messageID;
          promptTexts.push(params.parts.map((part) => part.text).join("\n"));
          await backfilled;
          writeIdleContinuationRecord(repoDir, params.sessionID);
          return { data: {} };
        },
        status: async () => {
          statusCalls += 1;
          return { data: { ses_old: { type: statusCalls === 1 ? "idle" : "busy" } } };
        },
        messages: async () => {
          releasePrompt?.();
          return {
            data: [
              {
                info: { id: "msg_old", role: "user", time: { created: 1 } },
                parts: [{ id: "part_old", messageID: "msg_old", sessionID: "ses_old", type: "text", text: priorPrompt, time: { start: 1, end: 2 } }],
              },
              {
                info: { id: "msg_plugin", role: "user", time: { created: 3 } },
                parts: [{ id: "part_plugin", messageID: "msg_plugin", sessionID: "ses_old", type: "text", text: pluginPrompt, time: { start: 3, end: 4 } }],
              },
              {
                info: { id: "asst_new", role: "assistant", parentID: sentMessageID, time: { created: 5, completed: 6 }, tokens: { output: 1 } },
                parts: [{ id: "part_new", messageID: "asst_new", sessionID: "ses_old", type: "text", text: "nudge complete", time: { start: 5, end: 6 } }],
              },
            ],
          };
        },
        children: async () => ({ data: [] }),
        abort: async () => ({ data: {} }),
      },
      event: {
        subscribe: async (_params: unknown, options: { signal: AbortSignal }) => {
          subscriptions += 1;
          return {
            stream: subscriptions === 1
              ? (async function* (): AsyncGenerator<never> {})()
              : (async function* (): AsyncGenerator<never> {
                  await waitForAbort(options.signal);
                })(),
          };
        },
      },
    } as unknown as OpencodeClient;

    const result = await runIteration({
      state,
      iteration: 1,
      client,
      repoDir,
      configDir,
      recoveryNudge: true,
      resume: { sessionID: "ses_old", messageID: "msg_old", stepName: "Build", promptText: priorPrompt, looperMessageIDs: ["msg_old"] },
      contextPolicy: CONTEXT_OFF,
      hooks: { onStepSession: (info) => sessionCalls.push(info) },
    });

    expect(result).toBe("complete");
    expect(created).toEqual([]);
    expect(prompted).toEqual(["ses_old"]);
    expect(promptTexts[0]).toContain("Continue working to completion if you haven't already.");
    expect(promptTexts[0]).toContain("If the work is already complete, report the result.");
    expect(promptTexts[0]).toContain("build from scratch\n");
    expect(state.steps[0]?.outputLines.join("\n")).not.toContain(priorPrompt);
    expect(state.steps[0]?.outputLines.join("\n")).toContain(pluginPrompt);
    expect(state.steps[0]?.promptText).toBe(promptTexts[0]);
    expect(sessionCalls.at(-1)).toEqual({
      iteration: 1,
      index: 0,
      stepName: "Build",
      sessionID: "ses_old",
      messageID: sentMessageID,
      promptText: promptTexts[0],
      looperMessageIDs: ["msg_old", sentMessageID],
    });
  });

  test("quit during resume health recovery stops without finishing the step as skipped", async () => {
    const originalProbeTimeout = process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS;
    process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS = "1";
    const { repoDir, configDir, state } = setup();
    const finished: string[] = [];
    let statusCalls = 0;
    const client = {
      session: {
        status: async () => {
          statusCalls += 1;
          if (statusCalls === 1) throw new Error("server unavailable");
          state.quitting = true;
          await new Promise<never>(() => {});
        },
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

    try {
      const result = await runIteration({
        state,
        iteration: 1,
        client,
        repoDir,
        configDir,
        resume: { sessionID: "ses_old", messageID: "msg_old", stepName: "Build" },
        hooks: { onStepFinish: (info) => finished.push(info.status) },
      });

      expect(result).toBe("stopped");
      expect(finished).toEqual([]);
      expect(state.steps[0]!.status).toBe("skipped");
    } finally {
      if (originalProbeTimeout === undefined) delete process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS;
      else process.env.LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS = originalProbeTimeout;
    }
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

describe("boot ctrl+c", () => {
  test("ctrl+c interrupts before normal keybindings are installed", () => {
    const fake = fakeRenderer();
    const calls: string[] = [];
    let prevented = 0;

    installBootInterruptHandler(fake.renderer as never, () => calls.push("interrupt"));

    fake.press({ ctrl: true, name: "c", preventDefault: () => prevented += 1 });

    expect(calls).toEqual(["interrupt"]);
    expect(prevented).toBe(1);
  });

  test("cleanup removes the temporary boot interrupt handler", () => {
    const handlers: ((k: KeyEventLike) => void)[] = [];
    const renderer = {
      keyInput: {
        on: (_event: string, handler: (k: KeyEventLike) => void) => handlers.push(handler),
        off: (_event: string, handler: (k: KeyEventLike) => void) => {
          const index = handlers.indexOf(handler);
          if (index !== -1) handlers.splice(index, 1);
        },
      },
    };
    const calls: string[] = [];

    const cleanup = installBootInterruptHandler(renderer as never, () => calls.push("interrupt"));
    cleanup();
    handlers.forEach((handler) => handler({ sequence: "\u0003" }));

    expect(calls).toEqual([]);
  });
});
