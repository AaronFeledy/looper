type ServerHealthResult = {
  readonly data?: {
    readonly version: string;
  };
  readonly error?: unknown;
};

type ServerHealthLookup = (signal: AbortSignal) => Promise<ServerHealthResult>;

export async function lookupServerVersion(
  health: ServerHealthLookup,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<string | undefined> {
  parentSignal.throwIfAborted();
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    abortListener = () => resolve(undefined);
    signal.addEventListener("abort", abortListener, { once: true });
  });
  const healthResult = health(signal).then(
    (result): ServerHealthResult | undefined => result,
    (_error: unknown): undefined => undefined,
  );

  try {
    const result = await Promise.race([healthResult, aborted]);
    parentSignal.throwIfAborted();
    return result?.error || !result?.data ? undefined : result.data.version;
  } finally {
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
}
