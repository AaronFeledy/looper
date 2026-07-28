import { describe, expect, test } from "bun:test";

import { startAgentRegistry } from "../src/opencode/agent-registry.ts";
import {
  createdEvent,
  deletedEvent,
  drainMicrotasks,
  FakeAgentRegistryClient,
  FakeEventFeed,
  sdkSession,
  statusEvent,
  waitUntil,
} from "./helpers/fake-agent-registry-client.ts";

const REPO_DIR = "/tmp/looper-agent-registry-test";

describe("SDK agent registry", () => {
  test("discovers a grandchild during breadth-first bootstrap", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    fake.children.set("root", [sdkSession({ id: "child", parentID: "root", createdAt: 10 })]);
    fake.children.set("child", [sdkSession({ id: "grandchild", parentID: "child", createdAt: 20 })]);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });

    // When
    registry.setRoots(["root"]);
    await drainMicrotasks();

    // Then
    expect(registry.projectRoot("root").map(({ sessionID, depth }) => ({ sessionID, depth }))).toEqual([
      { sessionID: "child", depth: 1 },
      { sessionID: "grandchild", depth: 2 },
    ]);
    registry.stop();
  });

  test("filters title children identified by metadata or agent", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    fake.children.set("root", [
      sdkSession({ id: "metadata-title", parentID: "root", metadata: { purpose: "title" } }),
      sdkSession({ id: "agent-title", parentID: "root", agent: "looper-title" }),
    ]);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });

    // When
    registry.setRoots(["root"]);
    await drainMicrotasks();

    // Then
    expect(registry.projectRoot("root")).toEqual([]);
    registry.stop();
  });

  test("adds a child from a session.created event", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    const feed = new FakeEventFeed();
    fake.queueFeed(feed);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });
    registry.setRoots(["root"]);
    await fake.waitForSubscriptions(1);

    // When
    feed.push(createdEvent(sdkSession({ id: "created", parentID: "root", agent: "build", createdAt: 10 })));
    await drainMicrotasks();

    // Then
    expect(registry.projectRoot("root")).toEqual([
      {
        sessionID: "created",
        parentSessionID: "root",
        depth: 1,
        agent: "build",
        title: "created",
        activity: "idle",
        startedAt: 10,
      },
    ]);
    registry.stop();
  });

  test("marks a known session busy from a session.status event", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    const feed = new FakeEventFeed();
    fake.queueFeed(feed);
    fake.children.set("root", [sdkSession({ id: "child", parentID: "root" })]);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });
    registry.setRoots(["root"]);
    await fake.waitForSubscriptions(1);
    await drainMicrotasks();

    // When
    feed.push(statusEvent("child", { type: "busy" }));
    await drainMicrotasks();

    // Then
    expect(registry.projectRoot("root")[0]?.activity).toBe("busy");
    registry.stop();
  });

  test("removes a deleted session and its subtree", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    const feed = new FakeEventFeed();
    fake.queueFeed(feed);
    const parent = sdkSession({ id: "parent", parentID: "root" });
    fake.children.set("root", [parent]);
    fake.children.set("parent", [sdkSession({ id: "child", parentID: "parent" })]);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });
    registry.setRoots(["root"]);
    await fake.waitForSubscriptions(1);
    await drainMicrotasks();

    // When
    feed.push(deletedEvent(parent));
    await drainMicrotasks();

    // Then
    expect(registry.projectRoot("root")).toEqual([]);
    registry.stop();
  });

  test("re-subscribes and re-bootstraps after a stream ends", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    const firstFeed = new FakeEventFeed();
    fake.queueFeed(firstFeed);
    fake.queueFeed(new FakeEventFeed());
    fake.children.set("root", [sdkSession({ id: "first", parentID: "root" })]);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });
    registry.setRoots(["root"]);
    await fake.waitForSubscriptions(1);
    await drainMicrotasks();
    fake.children.set("root", [
      sdkSession({ id: "first", parentID: "root" }),
      sdkSession({ id: "after-reconnect", parentID: "root", createdAt: 2 }),
    ]);

    // When
    firstFeed.end();
    await fake.waitForSubscriptions(2);

    // Then
    expect(registry.projectRoot("root").map(({ sessionID }) => sessionID)).toEqual(["first", "after-reconnect"]);
    registry.stop();
  });

  test("aborts its subscription and stops emitting when stopped", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    const feed = new FakeEventFeed();
    fake.queueFeed(feed);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });
    registry.setRoots(["root"]);
    await fake.waitForSubscriptions(1);
    let notifications = 0;
    registry.subscribe(() => {
      notifications += 1;
    });

    // When
    registry.stop();
    const notificationsAfterStop = notifications;
    feed.push(createdEvent(sdkSession({ id: "late", parentID: "root" })));
    await drainMicrotasks();

    // Then
    expect(fake.signals[0]?.aborted).toBe(true);
    expect(notifications).toBe(notificationsAfterStop);
    expect(registry.projectRoot("root")).toEqual([]);
  });

  test("prunes descendants when all roots are dropped", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    fake.children.set("root", [sdkSession({ id: "child", parentID: "root" })]);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });
    registry.setRoots(["root"]);
    await drainMicrotasks();

    // When
    registry.setRoots([]);

    // Then
    expect(registry.projectRoot("root")).toEqual([]);
    registry.stop();
  });

  test("keeps a session created while bootstrap is in flight after the bootstrap commits", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    const feed = new FakeEventFeed();
    fake.queueFeed(feed);
    fake.children.set("root", [sdkSession({ id: "known", parentID: "root", createdAt: 1 })]);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });
    const releaseChildren = fake.blockChildren();
    registry.setRoots(["root"]);
    await fake.waitForSubscriptions(1);
    await drainMicrotasks();

    // When
    feed.push(createdEvent(sdkSession({ id: "during-bootstrap", parentID: "root", createdAt: 5 })));
    await drainMicrotasks();
    const beforeCommit = registry.projectRoot("root").map(({ sessionID }) => sessionID);
    releaseChildren();
    await drainMicrotasks();

    // Then
    expect(beforeCommit).toEqual(["during-bootstrap"]);
    expect(registry.projectRoot("root").map(({ sessionID }) => sessionID)).toEqual(["known", "during-bootstrap"]);
    registry.stop();
  });

  test("drops a session deleted while bootstrap is in flight instead of resurrecting it", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    const feed = new FakeEventFeed();
    fake.queueFeed(feed);
    const doomed = sdkSession({ id: "doomed", parentID: "root", createdAt: 1 });
    fake.children.set("root", [doomed]);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });
    const releaseChildren = fake.blockChildren();
    registry.setRoots(["root"]);
    await fake.waitForSubscriptions(1);
    await drainMicrotasks();

    // When
    feed.push(deletedEvent(doomed));
    await drainMicrotasks();
    releaseChildren();
    await drainMicrotasks();

    // Then
    expect(registry.projectRoot("root")).toEqual([]);
    registry.stop();
  });

  test("retries bootstrap after a transient session.status failure", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    fake.statusFailures = 1;
    fake.children.set("root", [sdkSession({ id: "child", parentID: "root" })]);
    const errors: string[] = [];
    const registry = startAgentRegistry({
      client: fake.client,
      repoDir: REPO_DIR,
      onError: (message) => errors.push(message),
    });

    // When
    registry.setRoots(["root"]);
    await waitUntil(() => registry.projectRoot("root").length > 0);

    // Then
    expect(registry.projectRoot("root").map(({ sessionID }) => sessionID)).toEqual(["child"]);
    expect(errors).toEqual([]);
    registry.stop();
  });

  test("reports the failure once after exhausting bootstrap retries", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    fake.statusFailures = Number.MAX_SAFE_INTEGER;
    const errors: string[] = [];
    const registry = startAgentRegistry({
      client: fake.client,
      repoDir: REPO_DIR,
      onError: (message) => errors.push(message),
    });

    // When
    registry.setRoots(["root"]);
    await waitUntil(() => errors.length > 0);

    // Then
    expect(fake.statusCalls.length).toBe(3);
    expect(errors).toEqual(["session.status failed: status unavailable"]);
    registry.stop();
  });

  test("stops retrying a bootstrap once the root is dropped", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    fake.statusFailures = Number.MAX_SAFE_INTEGER;
    const errors: string[] = [];
    const registry = startAgentRegistry({
      client: fake.client,
      repoDir: REPO_DIR,
      onError: (message) => errors.push(message),
    });
    registry.setRoots(["root"]);
    await waitUntil(() => fake.statusCalls.length > 0);

    // When
    registry.setRoots([]);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Then
    expect(fake.statusCalls.length).toBe(1);
    expect(errors).toEqual([]);
    registry.stop();
  });

  test("lazily re-bootstraps when a created session has an unknown parent chain", async () => {
    // Given
    const fake = new FakeAgentRegistryClient();
    const feed = new FakeEventFeed();
    fake.queueFeed(feed);
    const registry = startAgentRegistry({ client: fake.client, repoDir: REPO_DIR });
    registry.setRoots(["root"]);
    await fake.waitForSubscriptions(1);
    await drainMicrotasks();
    const parent = sdkSession({ id: "parent", parentID: "root" });
    const child = sdkSession({ id: "child", parentID: "parent" });
    fake.children.set("root", [parent]);
    fake.children.set("parent", [child]);

    // When
    feed.push(createdEvent(child));
    await drainMicrotasks();

    // Then
    expect(registry.projectRoot("root").map(({ sessionID }) => sessionID)).toEqual(["parent", "child"]);
    registry.stop();
  });
});
