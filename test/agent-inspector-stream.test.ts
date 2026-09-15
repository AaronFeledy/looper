import { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, expect, test } from "bun:test";
import { startBackgroundAgentStreamer } from "../src/lib/background-agent-stream.ts";
import { closeAgentInspector, openAgentInspector } from "../src/lib/agent-inspector-state.ts";
import { cancelPendingNotify, createBackgroundAgent } from "../src/lib/state.ts";
import type { SessionMessageSnapshot } from "../src/lib/session-inspection.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";
import { assistantMessage, userMessage } from "./fixtures/session-messages.ts";

afterEach(cancelPendingNotify);
const tick = () => Bun.sleep(60);
type Query = { sessionID: string; limit?: number };
function clientWithMessages(messages: (query: Query, options: { signal: AbortSignal }) => Promise<{ data: SessionMessageSnapshot[] }>): OpencodeClient {
  const client = new OpencodeClient();
  Object.defineProperty(client, "session", { value: { messages } });
  return client;
}

test("defers child transcript loading until inspection, then loads all output and original prompt", async () => {
  const state = constellationFixture(), calls: Query[] = [];
  state.selectedBackgroundSessionID = "ses_tests";
  const child = state.steps[1]!.backgroundAgents[1]!;
  const stream = startBackgroundAgentStreamer({ state, repoDir: "/repo", client: clientWithMessages(async (query) => {
    calls.push(query);
    return { data: [userMessage(query.sessionID), assistantMessage(query.sessionID)] };
  }) });
  try {
    await tick();
    expect(calls).toHaveLength(0);
    openAgentInspector(state);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.limit).toBeUndefined();
    expect(child.outputLines.join("\n")).toContain("The unit tests passed.");
    expect(child.promptText).toBe("Build the activity bubbles.");
    expect(child.inspection?.metadata?.model).toBe("openai/reported-model");
    closeAgentInspector(state);
    await tick();
    expect(child.outputLines).toHaveLength(0);
    expect(child.activitySummary?.text).toBe("Running unit tests");
  } finally { stream.stop(); }
});

test("parent inspection fetches bounded metadata without replacing the live transcript", async () => {
  const state = constellationFixture(), calls: Query[] = [];
  const step = state.steps[1]!, original = step.outputEvents;
  openAgentInspector(state);
  const stream = startBackgroundAgentStreamer({ state, repoDir: "/repo", client: clientWithMessages(async (query) => {
    calls.push(query);
    return { data: [assistantMessage(query.sessionID)] };
  }) });
  try {
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionID: "ses_build", limit: 6 });
    expect(step.outputEvents).toBe(original);
    expect(step.inspection?.metadata?.variant).toBe("low");
  } finally { stream.stop(); }
});

test("closing inspection aborts requests and late replies cannot change the agent", async () => {
  const state = constellationFixture();
  state.selectedBackgroundSessionID = "ses_tests";
  const child = state.steps[1]!.backgroundAgents[1]!;
  let finish!: (result: { data: SessionMessageSnapshot[] }) => void;
  let signal!: AbortSignal;
  openAgentInspector(state);
  const stream = startBackgroundAgentStreamer({ state, repoDir: "/repo", client: clientWithMessages(async (_, options) => {
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  }) });
  try {
    closeAgentInspector(state);
    await tick();
    expect(signal.aborted).toBe(true);
    finish({ data: [assistantMessage("ses_tests")] });
    await tick();
    expect(child.inspection?.metadata).toBeUndefined();
    expect(child.outputLines).toHaveLength(0);
  } finally { stream.stop(); }
});

test("a replacement row with the same session ID cannot receive the old row's pending response", async () => {
  const state = constellationFixture();
  state.selectedBackgroundSessionID = "ses_tests";
  const old = state.steps[1]!.backgroundAgents[1]!;
  let finish!: (result: { data: SessionMessageSnapshot[] }) => void;
  openAgentInspector(state);
  const stream = startBackgroundAgentStreamer({ state, repoDir: "/repo", client: clientWithMessages(async () =>
    new Promise((resolve) => { finish = resolve; })) });
  try {
    const replacement = createBackgroundAgent("ses_tests", Date.now());
    state.steps[1]!.backgroundAgents[1] = replacement;
    finish({ data: [assistantMessage("ses_tests")] });
    await tick();
    expect(old.inspection?.metadata).toBeUndefined();
    expect(replacement.inspection?.metadata).toBeUndefined();
    expect(replacement.outputLines).toHaveLength(0);
  } finally { stream.stop(); }
});

test("metadata failures are visible and refresh can recover without claiming a configured default", async () => {
  const state = constellationFixture();
  let fail = true;
  openAgentInspector(state);
  const stream = startBackgroundAgentStreamer({ state, repoDir: "/repo", refreshMs: 20, client: clientWithMessages(async (query) => {
    if (fail) throw new Error("Session temporarily unavailable");
    return { data: [assistantMessage(query.sessionID)] };
  }) });
  try {
    await tick();
    expect(state.steps[1]!.inspection).toMatchObject({ status: "error", error: "Session temporarily unavailable" });
    expect(state.steps[1]!.inspection?.metadata).toBeUndefined();
    fail = false;
    await tick();
    expect(state.steps[1]!.inspection).toMatchObject({ status: "ready", metadata: { model: "openai/reported-model" } });
  } finally { stream.stop(); }
});


test("archived parents load their full transcript and hide Looper-owned prompts", async () => {
  const state = constellationFixture(), calls: Query[] = [];
  const archived = { ...state.steps[1]!, status: "done" as const, looperMessageIDs: ["msg_user"], outputLines: [], outputEvents: [] };
  state.retainedSteps = [archived]; state.selectedStepIndex = -1; state.selectedBackgroundSessionID = null;
  const user = userMessage("ses_build"); archived.looperMessageIDs = [user.info.id];
  openAgentInspector(state);
  const stream = startBackgroundAgentStreamer({ state, repoDir: "/repo", client: clientWithMessages(async query => {
    calls.push(query); return { data: [user, assistantMessage(query.sessionID)] };
  }) });
  try {
    await tick(); expect(calls[0]?.sessionID).toBe("ses_build"); expect(calls[0]?.limit).toBeUndefined();
    expect(archived.outputLines.join("\n")).toContain("The unit tests passed.");
    expect(archived.outputLines.join("\n")).not.toContain("Build the activity bubbles.");
    expect(state.steps[1]!.outputEvents).not.toBe(archived.outputEvents);
  } finally { stream.stop(); }
});
