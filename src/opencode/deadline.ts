import { withAbortSignal } from "./session-health.ts";

export async function sdkWithDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  options: { readonly remainingMs: number; readonly signal?: AbortSignal; readonly shouldStop?: () => boolean },
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new DOMException("SDK request interrupted", "AbortError"));
  const timer = setTimeout(abort, Math.max(0, options.remainingMs));
  const poll = options.shouldStop === undefined ? undefined : setInterval(() => { if (options.shouldStop?.()) abort(); }, 25);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted || options.shouldStop?.() || options.remainingMs <= 0) abort();
    controller.signal.throwIfAborted();
    return await withAbortSignal(Promise.resolve().then(() => call(controller.signal)), controller.signal);
  } finally {
    clearTimeout(timer);
    if (poll !== undefined) clearInterval(poll);
    options.signal?.removeEventListener("abort", abort);
  }
}
