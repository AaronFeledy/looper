import { OpencodeClient, type Event, type Session, type SessionStatus } from "@opencode-ai/sdk/v2";

const TEST_DIRECTORY = "/tmp/looper-agent-registry-test";

export type SessionInput = {
  readonly id: string;
  readonly parentID?: string;
  readonly agent?: string;
  readonly title?: string;
  readonly createdAt?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export function sdkSession(input: SessionInput): Session {
  return {
    id: input.id,
    slug: input.id,
    projectID: "project-test",
    directory: TEST_DIRECTORY,
    title: input.title ?? input.id,
    version: "test",
    time: { created: input.createdAt ?? 1, updated: input.createdAt ?? 1 },
    ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
  };
}

export function createdEvent(info: Session): Event {
  return { id: `event-created-${info.id}`, type: "session.created", properties: { sessionID: info.id, info } };
}

export function deletedEvent(info: Session): Event {
  return { id: `event-deleted-${info.id}`, type: "session.deleted", properties: { sessionID: info.id, info } };
}

export function statusEvent(sessionID: string, status: SessionStatus): Event {
  return { id: `event-status-${sessionID}`, type: "session.status", properties: { sessionID, status } };
}

export class FakeEventFeed {
  private readonly events: Event[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(event: Event): void {
    this.events.push(event);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *stream(signal: AbortSignal): AsyncGenerator<Event> {
    while (!signal.aborted) {
      const event = this.events.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal.removeEventListener("abort", wake);
          if (this.wake === wake) this.wake = undefined;
          resolve();
        };
        this.wake = wake;
        signal.addEventListener("abort", wake, { once: true });
      });
    }
  }
}

type SubscriptionWaiter = {
  readonly count: number;
  readonly resolve: () => void;
};

export class FakeAgentRegistryClient {
  readonly client: OpencodeClient;
  readonly children = new Map<string, Session[]>();
  readonly statuses: Record<string, SessionStatus> = {};
  readonly signals: AbortSignal[] = [];
  readonly childrenCalls: string[] = [];
  readonly messagesCalls: string[] = [];
  readonly statusCalls: string[] = [];
  subscribeCount = 0;
  statusFailures = 0;
  private readonly feeds: FakeEventFeed[] = [];
  private readonly subscriptionWaiters: SubscriptionWaiter[] = [];
  private childrenGate: Promise<void> | undefined;

  constructor() {
    const client = new OpencodeClient();
    Object.defineProperties(client, {
      event: {
        value: {
          subscribe: async (_parameters: unknown, options: { readonly signal: AbortSignal }) => {
            this.subscribeCount += 1;
            this.signals.push(options.signal);
            this.resolveSubscriptionWaiters();
            const feed = this.feeds.shift() ?? new FakeEventFeed();
            return { stream: feed.stream(options.signal) };
          },
        },
      },
      session: {
        value: {
          children: async ({ sessionID }: { readonly sessionID: string }) => {
            this.childrenCalls.push(sessionID);
            await this.childrenGate;
            return { data: [...(this.children.get(sessionID) ?? [])] };
          },
          messages: async ({ sessionID }: { readonly sessionID: string }) => {
            this.messagesCalls.push(sessionID);
            return { data: [] };
          },
          status: async () => {
            this.statusCalls.push("status");
            if (this.statusFailures > 0) {
              this.statusFailures -= 1;
              return { error: { message: "status unavailable" } };
            }
            return { data: { ...this.statuses } };
          },
        },
      },
    });
    this.client = client;
  }

  queueFeed(feed: FakeEventFeed): void {
    this.feeds.push(feed);
  }

  blockChildren(): () => void {
    let release = (): void => undefined;
    this.childrenGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.childrenGate = undefined;
      release();
    };
  }

  waitForSubscriptions(count: number): Promise<void> {
    if (this.subscribeCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.subscriptionWaiters.push({ count, resolve }));
  }

  private resolveSubscriptionWaiters(): void {
    for (let index = this.subscriptionWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.subscriptionWaiters[index];
      if (waiter === undefined || this.subscribeCount < waiter.count) continue;
      this.subscriptionWaiters.splice(index, 1);
      waiter.resolve();
    }
  }
}

export async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
