import { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, expect, test } from "bun:test";
import { startAgentActivityFeed } from "../src/lib/agent-activity-feed.ts";
import { cancelPendingNotify, createStepRow, notify } from "../src/lib/state.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";

afterEach(cancelPendingNotify);
function mockClient(messages: (params: { sessionID: string; limit?: number }, options: { signal: AbortSignal }) => Promise<unknown>) {
  const client = new OpencodeClient();
  Object.defineProperty(client, "session", { value: { messages } });
  return client;
}
const result = (sessionID: string) => ({ data: [{
  info: { id: "msg", sessionID, role: "assistant", time: { created: 1 } },
  parts: [{ id: "part", sessionID, messageID: "msg", type: "tool", tool: "bash", callID: "call",
    state: { status: "running", input: { command: "bun run test:unit" }, time: { start: 1 } } }],
}] });
async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("fetches all agents without selection, with bounded concurrency and message windows", async () => {
  const state = constellationFixture();
  state.selectedBackgroundSessionID = null;
  const requests: { sessionID: string; limit?: number; finish(): void }[] = [];
  let inFlight = 0;
  let peak = 0;
  const client = mockClient((params) => new Promise((resolve) => {
    inFlight++; peak = Math.max(peak, inFlight);
    requests.push({ ...params, finish() { inFlight--; resolve(result(params.sessionID)); } });
  }));
  const feed = startAgentActivityFeed({ state, client, repoDir: "/repo", refreshMs: 5 });
  try {
    expect(requests).toHaveLength(4);
    await Bun.sleep(10);
    requests[0]!.finish();
    await until(() => requests.length === 5);
    expect(requests[4]!.sessionID).toBe("ses_explore");
    requests.slice(1).forEach((request) => request.finish());
    await until(() => state.steps[1]!.backgroundAgents.every((agent) => agent.activitySummary?.text === "Running unit tests"));
    expect(peak).toBe(4);
    expect(requests.every((request) => request.limit === 6)).toBe(true);
    expect(state.steps[1]!.backgroundAgents.every((agent) => agent.outputEvents?.length === 0 && agent.outputLines.length === 0)).toBe(true);
  } finally { feed.stop(); }
});

test("cancels removed targets and ignores late responses after an iteration reset", async () => {
  const state = constellationFixture();
  const old = state.steps[1]!.backgroundAgents[0]!;
  const pending: { signal: AbortSignal; finish(): void }[] = [];
  const feed = startAgentActivityFeed({ state, repoDir: "/repo", client: mockClient((params, options) =>
    new Promise((resolve) => { pending.push({ signal: options.signal, finish: () => resolve(result(params.sessionID)) }); })) });
  try {
    state.steps = [createStepRow("next iteration")];
    notify();
    await until(() => pending.every((request) => request.signal.aborted));
    pending.forEach((request) => request.finish());
    await Bun.sleep(10);
    expect(old.activitySummary?.text).toBe("Writing the second component");
    expect(state.steps[0]!.backgroundAgents).toHaveLength(0);
  } finally { feed.stop(); }
});

test("stopping aborts every request and suppresses late updates", async () => {
  const state = constellationFixture();
  const pending: { signal: AbortSignal; finish(): void }[] = [];
  const feed = startAgentActivityFeed({ state, repoDir: "/repo", client: mockClient((params, options) =>
    new Promise((resolve) => { pending.push({ signal: options.signal, finish: () => resolve(result(params.sessionID)) }); })) });
  feed.stop();
  expect(pending.every((request) => request.signal.aborted)).toBe(true);
  pending.forEach((request) => request.finish());
  await Bun.sleep(10);
  expect(state.steps[1]!.backgroundAgents[0]!.activitySummary?.text).toBe("Writing the second component");
});

test("refreshes busy agents, reads an idle agent once, and reads once more when it settles", async () => {
  const state = constellationFixture();
  const counts = new Map<string, number>();
  const feed = startAgentActivityFeed({ state, repoDir: "/repo", refreshMs: 15, client: mockClient(async (params) => {
    counts.set(params.sessionID, (counts.get(params.sessionID) ?? 0) + 1);
    return result(params.sessionID);
  }) });
  try {
    await until(() => (counts.get("ses_components") ?? 0) >= 2);
    expect(counts.get("ses_explore")).toBe(1);
    state.steps[1]!.backgroundAgents[0]!.activity = "idle";
    const before = counts.get("ses_components")!;
    await until(() => counts.get("ses_components") === before + 1);
    await Bun.sleep(50);
    expect(counts.get("ses_components")).toBe(before + 1);
  } finally { feed.stop(); }
});


test("child snapshots use the configured PRD context", async () => {
  const state = constellationFixture();
  state.activityContext = { repoDir: "/repo", prdDir: "spec/feature" };
  const child = state.steps[1]!.backgroundAgents[0]!;
  const feed = startAgentActivityFeed({ state, repoDir: "/repo", client: mockClient(async (params) => {
    const snapshot = result(params.sessionID);
    const part = snapshot.data[0]!.parts[0]!;
    part.tool = "bash";
    part.state.input = { command: "tail -n 80 /repo/spec/feature/progress.txt" };
    return snapshot;
  }) });
  try {
    await until(() => child.activitySummary?.text === "Reviewing agent handoff notes");
    expect(child.outputEvents).toEqual([]);
  } finally { feed.stop(); }
});
