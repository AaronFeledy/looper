import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  EVENT_RESUBSCRIBE_BACKOFF_MS,
  EVENT_STALL_THRESHOLD_MS,
  EVENT_WATCHDOG_POLL_MS,
} from "../config/tunables.ts";
import { createSessionEventConsumer } from "../lib/event-consumer.ts";
import { classifyAssistantForMessage } from "./assistant-classification.ts";
import { EVENT_CONSUMER_CLOSE_TIMEOUT_MS } from "./continuation-records.ts";
import { sessionStillPending } from "./session-health.ts";
import { isAbortError, toError } from "./util.ts";

export type SessionEventConsumer = ReturnType<typeof createSessionEventConsumer>;

export type PromptEventStream = {
  readonly setSentMessageID: (messageID: string) => void;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly flush: () => void;
  readonly consumerError: () => Error | undefined;
  readonly watchdogStallReason: () => string | undefined;
};

type PromptEventStreamTimings = {
  readonly pollMs: number;
  readonly stallThresholdMs: number;
  readonly resubscribeBackoffMs: number;
};

const DEFAULT_PROMPT_EVENT_STREAM_TIMINGS: PromptEventStreamTimings = {
  pollMs: EVENT_WATCHDOG_POLL_MS,
  stallThresholdMs: EVENT_STALL_THRESHOLD_MS,
  resubscribeBackoffMs: EVENT_RESUBSCRIBE_BACKOFF_MS,
};

export function createPromptEventStream({
  client,
  repoDir,
  sessionID,
  subscription,
  promptAbortController,
  cancellationActive,
  pushLine,
  consumer,
  timings = DEFAULT_PROMPT_EVENT_STREAM_TIMINGS,
}: {
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly sessionID: string;
  readonly subscription: { ctrl: AbortController | undefined };
  readonly promptAbortController: AbortController;
  readonly cancellationActive: () => boolean;
  readonly pushLine: (line: string) => void;
  readonly consumer: SessionEventConsumer;
  readonly timings?: PromptEventStreamTimings;
}): PromptEventStream {
  let consumerPromise: Promise<void> | undefined;
  let consumerError: Error | undefined;
  let supervisorPromise: Promise<void> | undefined;
  let supervisorStopped = false;
  let watchdogStallReason: string | undefined;
  let lastEventAt = Date.now();
  let sentMessageID: string | undefined;

  const subscribeStream = async (): Promise<AsyncIterable<Event> | undefined> => {
    const sc = new AbortController();
    subscription.ctrl = sc;
    const sub = await client.event.subscribe({ directory: repoDir }, { signal: sc.signal });
    return sub.stream ?? undefined;
  };

  async function* trackActivity(stream: AsyncIterable<Event>): AsyncGenerator<Event> {
    for await (const event of stream) {
      lastEventAt = Date.now();
      yield event;
    }
  }

  const startConsume = (stream: AsyncIterable<Event>): void => {
    consumerPromise = consumer.consume(trackActivity(stream)).catch((err) => {
      const error = toError(err);
      if (isAbortError(error)) return;
      consumerError = error;
      pushLine(`[error] event consumer crashed: ${error.message}`);
    });
  };

  let lastResubscribeAt = 0;
  const resubscribe = async (reason: string): Promise<boolean> => {
    if (supervisorStopped || cancellationActive()) return false;
    const sinceLast = Date.now() - lastResubscribeAt;
    if (sinceLast < timings.resubscribeBackoffMs) await Bun.sleep(timings.resubscribeBackoffMs - sinceLast);
    if (supervisorStopped || cancellationActive()) return false;
    lastResubscribeAt = Date.now();
    subscription.ctrl?.abort();
    if (consumerPromise) {
      await Promise.race([consumerPromise, Bun.sleep(EVENT_CONSUMER_CLOSE_TIMEOUT_MS)]).catch(() => undefined);
    }
    if (supervisorStopped || cancellationActive()) return false;
    const stream = await subscribeStream().catch(() => undefined);
    if (!stream) {
      pushLine(`[looper] resubscribe failed to obtain a stream (${reason})`);
      return false;
    }
    try {
      const msgs = await client.session.messages({ sessionID, directory: repoDir });
      if (!msgs.error && msgs.data) consumer.backfill(msgs.data);
    } catch {
      // backfill is best-effort; live events will continue to heal state
    }
    // Backfill first so the consumer's per-part length guards are in place
    // before live deltas from the new stream are appended. This prevents
    // overlapping replay from double-printing assistant text.
    lastEventAt = Date.now();
    startConsume(stream);
    pushLine(`[looper] resubscribed to events for ${sessionID} (${reason})`);
    return true;
  };

  const supervise = async (): Promise<void> => {
    while (!supervisorStopped && !cancellationActive()) {
      const current = consumerPromise ?? Promise.resolve();
      const outcome = await Promise.race([
        current.then(() => "ended" as const),
        Bun.sleep(timings.pollMs).then(() => "tick" as const),
      ]);
      if (supervisorStopped || cancellationActive()) break;

      const streamEnded = outcome === "ended";
      if (!streamEnded && Date.now() - lastEventAt < timings.stallThresholdMs) continue;

      let pending: boolean | undefined;
      try {
        pending = await sessionStillPending(client, repoDir, sessionID);
      } catch {
        pending = undefined;
      }
      if (supervisorStopped || cancellationActive()) break;

      if (pending === undefined) {
        if (streamEnded && !(await resubscribe("stream closed; session status unknown"))) {
          await Bun.sleep(timings.resubscribeBackoffMs);
        }
        continue;
      }

      if (pending) {
        const reason = streamEnded ? "stream closed while session busy" : "no events while session busy";
        if (!(await resubscribe(reason))) await Bun.sleep(timings.resubscribeBackoffMs);
        continue;
      }

      if (sentMessageID !== undefined) {
        const cls = await classifyAssistantForMessage(client, repoDir, sessionID, sentMessageID);
        if (supervisorStopped || cancellationActive()) break;
        if (cls.kind === "done" || cls.kind === "failed" || cls.kind === "empty") {
          const silentSeconds = Math.round((Date.now() - lastEventAt) / 1000);
          const detail = cls.kind === "failed" || cls.kind === "empty" ? `: ${cls.errorMessage}` : "";
          watchdogStallReason = `event watchdog: session ${sessionID} idle with assistant message ${cls.kind}${detail} but no events for ${silentSeconds}s; aborting prompt to finalize via reattach`;
          pushLine(`[looper] ${watchdogStallReason}`);
          promptAbortController.abort();
          break;
        }
        const inProgressReason = streamEnded
          ? "stream closed; assistant still in-progress"
          : "stream stalled; assistant still in-progress";
        if (!(await resubscribe(inProgressReason))) {
          await Bun.sleep(timings.resubscribeBackoffMs);
        }
        continue;
      }

      if (streamEnded && !(await resubscribe("stream closed before prompt"))) {
        await Bun.sleep(timings.resubscribeBackoffMs);
      }
    }
  };

  return {
    setSentMessageID: (messageID: string): void => {
      sentMessageID = messageID;
    },
    start: async (): Promise<void> => {
      const stream0 = await subscribeStream();
      if (!stream0) throw new Error("event.subscribe returned no stream");
      pushLine(`[looper] subscribed to events`);
      lastEventAt = Date.now();
      startConsume(stream0);
      supervisorPromise = supervise();
    },
    stop: async (): Promise<void> => {
      supervisorStopped = true;
      subscription.ctrl?.abort();
      if (supervisorPromise) {
        await Promise.race([supervisorPromise, Bun.sleep(EVENT_CONSUMER_CLOSE_TIMEOUT_MS)]).catch(() => undefined);
      }
      if (consumerPromise) {
        let timedOut = false;
        await Promise.race([
          consumerPromise,
          Bun.sleep(EVENT_CONSUMER_CLOSE_TIMEOUT_MS).then(() => {
            timedOut = true;
          }),
        ]).catch(() => undefined);
        if (timedOut) pushLine(`[looper] event stream did not close within ${EVENT_CONSUMER_CLOSE_TIMEOUT_MS}ms; continuing`);
      }
    },
    flush: consumer.flush,
    consumerError: () => consumerError,
    watchdogStallReason: () => watchdogStallReason,
  };
}
