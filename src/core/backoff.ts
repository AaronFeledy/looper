export type BackoffPolicy = {
  readonly baseMs: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly maxAttempts?: number;
  readonly maxTotalMs?: number;
};

export type RetryWithBackoffOptions = {
  readonly signal?: AbortSignal;
  readonly shouldStop?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly isRetryable?: (error: unknown) => boolean;
};

export class BackoffAbortedError extends Error {
  readonly reasonValue?: unknown;

  constructor(reasonValue?: unknown) {
    super("retry aborted");
    this.name = "BackoffAbortedError";
    if (reasonValue !== undefined) this.reasonValue = reasonValue;
  }
}

const DEFAULT_MULTIPLIER = 2;
const SHOULD_STOP_SLEEP_POLL_MS = 250;

export function backoffDelayMs(policy: BackoffPolicy, attempt: number, remainingMs?: number): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  const multiplier = policy.multiplier ?? DEFAULT_MULTIPLIER;
  const delay = policy.baseMs * multiplier ** normalizedAttempt;
  const cappedDelay = policy.maxDelayMs === undefined ? delay : Math.min(delay, policy.maxDelayMs);
  if (remainingMs === undefined) return Math.max(0, cappedDelay);
  return Math.min(Math.max(0, cappedDelay), Math.max(1, remainingMs));
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  policy: BackoffPolicy,
  options: RetryWithBackoffOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = policy.maxTotalMs === undefined ? undefined : now() + Math.max(0, policy.maxTotalMs);
  let attempt = 0;

  while (true) {
    throwIfCancelled(options.signal, options.shouldStop);
    try {
      return await fn(attempt);
    } catch (error) {
      if (options.isRetryable?.(error) === false) throw error;
      const nextAttempt = attempt + 1;
      if (policy.maxAttempts !== undefined && nextAttempt >= policy.maxAttempts) throw error;
      throwIfCancelled(options.signal, options.shouldStop);
      const remainingMs = deadline === undefined ? undefined : deadline - now();
      if (remainingMs !== undefined && remainingMs <= 0) throw error;
      const delayMs = backoffDelayMs(policy, attempt, remainingMs);
      await sleepWithCancellation({ ms: delayMs, sleep, signal: options.signal, shouldStop: options.shouldStop });
      attempt = nextAttempt;
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new BackoffAbortedError(reason);
}

function throwIfCancelled(signal: AbortSignal | undefined, shouldStop: (() => boolean) | undefined): void {
  if (signal?.aborted) throw signalAbortError(signal);
  if (shouldStop?.()) throw new BackoffAbortedError();
}

async function sleepWithAbort(sleeping: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await sleeping;
    return;
  }
  if (signal.aborted) throw signalAbortError(signal);
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signalAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    await Promise.race([sleeping, aborted]);
  } finally {
    removeAbortListener?.();
  }
}

async function sleepWithCancellation({
  ms,
  sleep,
  signal,
  shouldStop,
}: {
  readonly ms: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal | undefined;
  readonly shouldStop: (() => boolean) | undefined;
}): Promise<void> {
  let remainingMs = Math.max(0, ms);
  while (remainingMs > 0) {
    throwIfCancelled(signal, shouldStop);
    const chunkMs = shouldStop === undefined ? remainingMs : Math.min(SHOULD_STOP_SLEEP_POLL_MS, remainingMs);
    await sleepWithAbort(sleep(chunkMs), signal);
    remainingMs -= chunkMs;
  }
}
