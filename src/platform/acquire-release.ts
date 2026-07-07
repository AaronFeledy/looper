export type ReleaseOutcome = { readonly ok: boolean; readonly error?: unknown };

export type ReleaseErrorObserver<R> = (error: unknown, resource: R, outcome: ReleaseOutcome) => void | Promise<void>;

export type AcquireReleaseOptions<R> = {
  readonly onReleaseError?: ReleaseErrorObserver<R>;
};

const ignoreReleaseError = (): void => {
  // Release is best-effort: cleanup failures must not mask the use-path outcome.
};

export async function acquireRelease<R, T>(
  acquire: () => Promise<R>,
  use: (resource: R) => Promise<T>,
  release: (resource: R, outcome: ReleaseOutcome) => Promise<void> | void,
  options: AcquireReleaseOptions<R> = {},
): Promise<T> {
  const resource = await acquire();
  const onReleaseError: ReleaseErrorObserver<R> = options.onReleaseError ?? ignoreReleaseError;

  const releaseSafely = async (outcome: ReleaseOutcome): Promise<void> => {
    try {
      await release(resource, outcome);
    } catch (releaseError) {
      await onReleaseError(releaseError, resource, outcome);
    }
  };

  try {
    const value = await use(resource);
    await releaseSafely({ ok: true });
    return value;
  } catch (error) {
    await releaseSafely({ ok: false, error });
    throw error;
  }
}
