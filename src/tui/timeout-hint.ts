export type TimeoutHintSnapshot = {
  readonly remainingMs: number;
  readonly originalMs: number;
};

const TWO_MINUTES_MS = 2 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;

export function timeoutExtendHintThresholdMs(originalMs: number): number {
  if (originalMs < TWO_MINUTES_MS) return Math.floor(Math.max(0, originalMs) * 0.1);
  return Math.min(FIVE_MINUTES_MS, Math.max(TWO_MINUTES_MS, originalMs * 0.1));
}

export function formatTimeoutRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.floor(remainingMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

export function timeoutExtendHintText(snapshot: TimeoutHintSnapshot | undefined): string | undefined {
  if (snapshot === undefined) return undefined;
  if (snapshot.remainingMs <= 0) return undefined;
  if (snapshot.remainingMs > timeoutExtendHintThresholdMs(snapshot.originalMs)) return undefined;
  return `timeout in ${formatTimeoutRemaining(snapshot.remainingMs)} — [t] extend`;
}
