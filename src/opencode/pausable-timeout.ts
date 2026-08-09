export interface TimeoutScheduler {
  readonly now: number;
  setTimeout(callback: () => void, milliseconds: number): object;
  clearTimeout(handle: object): void;
}

export type PausableTimeout = {
  readonly setGateOpen: (open: boolean) => void;
  readonly dispose: () => void;
};

const systemTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();
const systemScheduler: TimeoutScheduler = {
  get now() { return Date.now(); },
  setTimeout(callback, milliseconds) {
    const handle = {};
    systemTimers.set(handle, setTimeout(callback, milliseconds));
    return handle;
  },
  clearTimeout(handle) {
    const timer = systemTimers.get(handle);
    if (timer !== undefined) clearTimeout(timer);
    systemTimers.delete(handle);
  },
};

export function createPausableTimeout(options: {
  readonly durationMs: number;
  readonly onElapsed: () => void;
  readonly scheduler?: TimeoutScheduler;
}): PausableTimeout {
  const scheduler = options.scheduler ?? systemScheduler;
  let remainingMs = Math.max(0, options.durationMs);
  let armedAt = scheduler.now;
  let handle: object | undefined;
  let paused = false;
  let disposed = false;

  const arm = (): void => {
    if (disposed || paused || handle !== undefined) return;
    armedAt = scheduler.now;
    handle = scheduler.setTimeout(() => {
      handle = undefined;
      if (!disposed) options.onElapsed();
    }, Math.max(0, remainingMs));
  };

  arm();
  return {
    setGateOpen(open) {
      if (disposed || open === paused) return;
      paused = open;
      if (open) {
        if (handle !== undefined) scheduler.clearTimeout(handle);
        handle = undefined;
        remainingMs = Math.max(0, remainingMs - (scheduler.now - armedAt));
        return;
      }
      arm();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (handle !== undefined) scheduler.clearTimeout(handle);
      handle = undefined;
    },
  };
}
