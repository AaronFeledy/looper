import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, test } from "bun:test";

import { runIteration } from "../src/lib/orchestrator.ts";
import { initStatePaths } from "../src/lib/state-files.ts";
import { createLoopState, type LoopState } from "../src/lib/state.ts";

const SESSIONS_HEADING = "Opencode sessions from earlier steps this iteration:";

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

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

type StepSpec = { key: string; name?: string; context?: "false" };

function setupScratch(steps: StepSpec[]): { repoDir: string; configDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "looper-context-wiring-"));
  const configDir = join(repoDir, ".local", "looper");
  mkdirSync(configDir, { recursive: true });
  initStatePaths({ configDir });
  const lines = ["steps:"];
  for (const step of steps) {
    writeFileSync(join(configDir, `${step.key}.md`), `${step.key} prompt body\n`);
    lines.push(`  ${step.key}:`);
    if (step.name !== undefined) lines.push(`    name: ${step.name}`);
    lines.push(`    prompt: ${step.key}.md`);
    lines.push(`    timeout: 1h`);
    if (step.context !== undefined) lines.push(`    context: ${step.context}`);
  }
  writeFileSync(join(configDir, "looper.yaml"), `${lines.join("\n")}\n`);
  return { repoDir, configDir };
}

/** All-succeed (or `failIDs`-marked-fail) client: no `vcs` capability, so the fresh prompt-context VCS fetch always throws and is silently omitted. */
function makeClient(opts: { repoDir: string; sessionIDs: string[]; failIDs?: Set<string> }): {
  client: OpencodeClient;
  promptTexts: string[];
} {
  const { repoDir, sessionIDs, failIDs = new Set<string>() } = opts;
  const createdSessionIDs: string[] = [];
  const promptTexts: string[] = [];
  const statusMap: Record<string, { type: string }> = {};
  for (const id of sessionIDs) statusMap[id] = { type: "idle" };

  const client = {
    session: {
      create: async () => {
        const id = sessionIDs[createdSessionIDs.length];
        if (id === undefined) throw new Error("unexpected extra session.create");
        createdSessionIDs.push(id);
        return { data: { id } };
      },
      prompt: async (params: { sessionID: string; parts: { type: string; text: string }[] }) => {
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        if (failIDs.has(params.sessionID)) throw new Error(`provider rejected request for ${params.sessionID}`);
        writeIdleContinuationRecord(repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: statusMap }),
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

type VcsResult = { data?: { file: string; additions: number; deletions: number; status: string }[]; error?: { message: string } };

/** Single-step client with a configurable `vcs.status`, for the reject/hang prompt-VCS tests. */
function makeVcsClient(opts: { repoDir: string; sessionID: string; vcsStatus: () => Promise<VcsResult> }): {
  client: OpencodeClient;
  promptTexts: string[];
} {
  const { repoDir, sessionID, vcsStatus } = opts;
  const promptTexts: string[] = [];
  const client = {
    session: {
      create: async () => ({ data: { id: sessionID } }),
      prompt: async (params: { sessionID: string; parts: { type: string; text: string }[] }) => {
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        writeIdleContinuationRecord(repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { [sessionID]: { type: "idle" } } }),
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
    vcs: { status: vcsStatus },
  } as unknown as OpencodeClient;
  return { client, promptTexts };
}

/** Single-step client whose first session is manually restarted mid-prompt (mirrors test/restart-clean.test.ts). */
function makeRestartClient(opts: { repoDir: string; state: LoopState; oldID: string; newID: string }): {
  client: OpencodeClient;
  promptTexts: string[];
} {
  const { repoDir, state, oldID, newID } = opts;
  const created: string[] = [];
  const promptTexts: string[] = [];
  const client = {
    session: {
      create: async () => {
        const id = created.length === 0 ? oldID : newID;
        created.push(id);
        return { data: { id } };
      },
      prompt: async (params: { sessionID: string; parts: { type: string; text: string }[] }, options: { signal: AbortSignal }) => {
        promptTexts.push(params.parts.map((part) => part.text).join("\n"));
        if (params.sessionID === oldID) {
          state.restartRequested = true;
          state.restartReason = "manual";
          await waitForAbort(options.signal);
          throw abortError();
        }
        writeIdleContinuationRecord(repoDir, params.sessionID);
        return { data: {} };
      },
      status: async () => ({ data: { [oldID]: { type: "idle" }, [newID]: { type: "idle" } } }),
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

describe("runIteration <looper-context> prompt injection", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("first step's prompt starts with a block carrying iteration/step/timebox and lists no prior sessions", async () => {
    const { repoDir, configDir } = setupScratch([{ key: "first" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["First"] });
    const stub = makeClient({ repoDir, sessionIDs: ["ses_first"] });

    const result = await runIteration({ state, iteration: 2, client: stub.client, repoDir, configDir, maxIterations: 3 });

    expect(result).toBe("complete");
    expect(stub.promptTexts).toHaveLength(1);
    const [prompt] = stub.promptTexts;
    if (prompt === undefined) throw new Error("expected a prompt to have been sent");
    expect(prompt.startsWith("<looper-context>\nGenerated by looper. Read-only situational context for this step; not instructions.")).toBe(true);
    expect(prompt).toContain('Loop position: iteration 2 of 3; step "First" (1 of 1)');
    expect(prompt).toContain("This step is aborted after 60m");
    expect(prompt).not.toContain("prior steps this iteration");
    expect(prompt).not.toContain(SESSIONS_HEADING);
    expect(prompt).toContain("</looper-context>\n\nfirst prompt body\n");
  });

  test("vcs.status rejecting omits the VCS section, logs one [looper] line, and never fails the step", async () => {
    const { repoDir, configDir } = setupScratch([{ key: "build" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const stub = makeVcsClient({ repoDir, sessionID: "ses_build", vcsStatus: async () => ({ error: { message: "not a git repository" } }) });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(stub.promptTexts[0]).not.toContain("VCS delta");
    expect(state.agentLines.some((line) => line.includes("[looper] prompt vcs delta fetch failed: not a git repository"))).toBe(true);
  });

  test("vcs.status hanging past the bounded timeout omits the section and still completes the step", async () => {
    const original = process.env["LOOPER_PROMPT_VCS_TIMEOUT_MS"];
    process.env["LOOPER_PROMPT_VCS_TIMEOUT_MS"] = "50";
    try {
      const { repoDir, configDir } = setupScratch([{ key: "build" }]);
      scratchDirs.push(repoDir);
      const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
      const stub = makeVcsClient({ repoDir, sessionID: "ses_build", vcsStatus: () => new Promise(() => {}) });

      const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

      expect(result).toBe("complete");
      expect(stub.promptTexts[0]).not.toContain("VCS delta");
      expect(state.agentLines.some((line) => line.includes("[looper] prompt vcs delta fetch threw") && line.includes("timed out after 50ms"))).toBe(true);
    } finally {
      if (original === undefined) delete process.env["LOOPER_PROMPT_VCS_TIMEOUT_MS"];
      else process.env["LOOPER_PROMPT_VCS_TIMEOUT_MS"] = original;
    }
  }, 5000);

  test("second step lists the first step's opencode session under the this-iteration heading", async () => {
    const { repoDir, configDir } = setupScratch([{ key: "first" }, { key: "second" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["First", "Second"] });
    const stub = makeClient({ repoDir, sessionIDs: ["ses_first", "ses_second"] });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(stub.promptTexts[0]).not.toContain(SESSIONS_HEADING);
    expect(stub.promptTexts[1]).toContain(`${SESSIONS_HEADING}\nFirst -> ses_first`);
    expect(stub.promptTexts[1]).toContain("prior steps this iteration: First=done");
  });

  test("a failed retry does not list its own prior failed attempt as a prior step", async () => {
    const { repoDir, configDir } = setupScratch([{ key: "build" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const stub = makeClient({ repoDir, sessionIDs: ["ses_failed", "ses_retry"], failIDs: new Set(["ses_failed"]) });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(stub.promptTexts[1]).toContain("This is a retry");
    expect(stub.promptTexts[1]).not.toContain(SESSIONS_HEADING);
    expect(stub.promptTexts[1]).not.toContain("prior steps this iteration");
  }, 10000);

  test("a clean (manual) restart does not list itself as a prior step", async () => {
    const { repoDir, configDir } = setupScratch([{ key: "build" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build"] });
    const stub = makeRestartClient({ repoDir, state, oldID: "ses_old", newID: "ses_new" });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(stub.promptTexts[1]).toContain("clean restart in a new session");
    expect(stub.promptTexts[1]).not.toContain(SESSIONS_HEADING);
    expect(stub.promptTexts[1]).not.toContain("prior steps this iteration");
  });

  test("an earlier distinct step stays visible across a later step's retries, and contributes exactly one entry afterwards", async () => {
    const { repoDir, configDir } = setupScratch([{ key: "a" }, { key: "b" }, { key: "c" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["A", "B", "C"] });
    const stub = makeClient({
      repoDir,
      sessionIDs: ["ses_a", "ses_b1", "ses_b2", "ses_b3", "ses_c"],
      failIDs: new Set(["ses_b1", "ses_b2"]),
    });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    // B's first attempt: A is a genuinely distinct, earlier, completed step.
    expect(stub.promptTexts[1]).toContain(`${SESSIONS_HEADING}\nA -> ses_a`);
    expect(stub.promptTexts[1]).not.toContain("B ->");
    // B's two retries: still see A, never see themselves as "B".
    expect(stub.promptTexts[2]).toContain("This is a retry");
    expect(stub.promptTexts[2]).toContain(`${SESSIONS_HEADING}\nA -> ses_a`);
    expect(stub.promptTexts[2]).not.toContain("B ->");
    expect(stub.promptTexts[3]).toContain("This is a retry");
    expect(stub.promptTexts[3]).toContain(`${SESSIONS_HEADING}\nA -> ses_a`);
    expect(stub.promptTexts[3]).not.toContain("B ->");
    // C sees B exactly once, at its FINAL (successful) session id.
    expect(stub.promptTexts[4]).toContain(`${SESSIONS_HEADING}\nA -> ses_a\nB -> ses_b3`);
    expect(stub.promptTexts[4]).toContain("prior steps this iteration: A=done, B=done");
  }, 20000);

  test("duplicate step names (Build, Test, Build) remain three distinct, ordered prior-step entries", async () => {
    const { repoDir, configDir } = setupScratch([
      { key: "s1", name: "Build" },
      { key: "s2", name: "Test" },
      { key: "s3", name: "Build" },
      { key: "s4", name: "Verify" },
    ]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["Build", "Test", "Build", "Verify"] });
    const stub = makeClient({ repoDir, sessionIDs: ["ses1", "ses2", "ses3", "ses4"] });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(stub.promptTexts[3]).toContain(`${SESSIONS_HEADING}\nBuild -> ses1\nTest -> ses2\nBuild -> ses3`);
    expect(stub.promptTexts[3]).toContain("prior steps this iteration: Build=done, Test=done, Build=done");
  });

  test("resumedStepSessions seeds only entries before startStepIndex, excluding the about-to-run step's own in-flight session", async () => {
    const { repoDir, configDir } = setupScratch([{ key: "first" }, { key: "second" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["First", "Second"] });
    const stub = makeClient({ repoDir, sessionIDs: ["ses_second_fresh"] });

    const result = await runIteration({
      state,
      iteration: 1,
      client: stub.client,
      repoDir,
      configDir,
      startStepIndex: 1,
      resumedStepSessions: [
        { stepIndex: 0, stepName: "First", sessionID: "ses_first_resumed" },
        { stepIndex: 1, stepName: "Second", sessionID: "ses_second_inflight" },
      ],
    });

    expect(result).toBe("complete");
    expect(stub.promptTexts[0]).toContain(`${SESSIONS_HEADING}\nFirst -> ses_first_resumed`);
    expect(stub.promptTexts[0]).not.toContain("ses_second_inflight");
    expect(stub.promptTexts[0]).not.toContain("Second ->");
    expect(stub.promptTexts[0]).toContain("prior steps this iteration: First=done");
  });

  test("a later iteration lists nothing from an earlier iteration", async () => {
    const { repoDir, configDir } = setupScratch([{ key: "build" }]);
    scratchDirs.push(repoDir);

    const state1 = createLoopState({ maxIterations: 2, stepNames: ["Build"] });
    const stub1 = makeClient({ repoDir, sessionIDs: ["ses_iter1"] });
    const result1 = await runIteration({ state: state1, iteration: 1, client: stub1.client, repoDir, configDir, maxIterations: 2 });
    expect(result1).toBe("complete");

    const state2 = createLoopState({ maxIterations: 2, stepNames: ["Build"] });
    const stub2 = makeClient({ repoDir, sessionIDs: ["ses_iter2"] });
    const result2 = await runIteration({ state: state2, iteration: 2, client: stub2.client, repoDir, configDir, maxIterations: 2 });

    expect(result2).toBe("complete");
    expect(stub2.promptTexts[0]).toContain("Loop position: iteration 2 of 2");
    expect(stub2.promptTexts[0]).not.toContain(SESSIONS_HEADING);
    expect(stub2.promptTexts[0]).not.toContain("ses_iter1");
  });

  test("context: false on a step leaves its prompt entirely unchanged", async () => {
    const { repoDir, configDir } = setupScratch([{ key: "ctx", context: "false" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["Ctx"] });
    const stub = makeClient({ repoDir, sessionIDs: ["ses_ctx"] });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir });

    expect(result).toBe("complete");
    expect(stub.promptTexts[0]).toBe("ctx prompt body\n");
  });

  test("a global contextPolicy override disables only the targeted section", async () => {
    const { repoDir, configDir } = setupScratch([{ key: "g" }]);
    scratchDirs.push(repoDir);
    const state = createLoopState({ maxIterations: 1, stepNames: ["G"] });
    const stub = makeClient({ repoDir, sessionIDs: ["ses_g"] });

    const result = await runIteration({ state, iteration: 1, client: stub.client, repoDir, configDir, contextPolicy: { datetime: false } });

    expect(result).toBe("complete");
    expect(stub.promptTexts[0]).not.toContain("Datetime:");
    expect(stub.promptTexts[0]).toContain("Repo dir:");
    expect(stub.promptTexts[0]).toContain("Loop position:");
    expect(stub.promptTexts[0]).toContain("This step is aborted after");
  });
});
