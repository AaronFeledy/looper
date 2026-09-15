import type { Writable } from "node:stream";

export function installProcessSignals(handle: (signal: "SIGINT" | "SIGTERM") => void): Disposable {
  const interrupt = (): void => handle("SIGINT");
  const terminate = (): void => handle("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return { [Symbol.dispose]: () => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  } };
}

/** Grace before a non-TTY run that will not unwind naturally is force-exited. */
export const NATURAL_EXIT_WATCHDOG_MS = 10_000;

/**
 * Exit without truncating output OR hanging.
 *
 * `process.exit()` truncates a PIPED stdout: Bun buffers pipe writes
 * asynchronously, and neither a write callback nor `writableLength` reports the
 * pending bytes, so an 8MB write can deliver ~64KB. Only a natural exit flushes
 * it. A TTY writes synchronously and therefore cannot truncate.
 *
 * So exit immediately under the TUI (stdout is a TTY, and its renderer/stdin
 * handles otherwise keep the event loop alive indefinitely), and let a non-TTY
 * run end naturally. The watchdog is unref'd, so it never delays a clean
 * unwind; it only fires when something stays ref'd — e.g. an interrupted prompt
 * leaves a live SDK socket to a server we just killed, which previously hung
 * the process forever after SIGTERM.
 */
export function scheduleProcessExit(options: {
  readonly tui: boolean;
  readonly code: number;
  readonly exit: (code: number) => void;
  readonly schedule?: (callback: () => void, ms: number) => { unref?: () => void };
  readonly watchdogMs?: number;
}): void {
  if (options.tui) {
    options.exit(options.code);
    return;
  }
  const schedule = options.schedule ?? setTimeout;
  const handle = schedule(() => options.exit(options.code), options.watchdogMs ?? NATURAL_EXIT_WATCHDOG_MS);
  handle.unref?.();
}

export async function flushOutput(streams: readonly Writable[], timeoutMs = 2000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
        if (stream.destroyed || stream.writableFinished) return resolve();
        stream.write("", () => resolve());
      }))),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runStartupProbe(command: readonly string[], options: {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<string | undefined> {
  if (options.signal?.aborted) return undefined;
  const proc = Bun.spawn([...command], { cwd: options.cwd, stdout: "pipe", stderr: "ignore" });
  let cancelled = false;
  const cancel = (): void => { cancelled = true; proc.kill("SIGKILL"); };
  const timer = setTimeout(cancel, options.timeoutMs ?? 2000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return cancelled || code !== 0 ? undefined : output.trim();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    await proc.exited;
  }
}

export async function closeBeforeExit(close: (() => Promise<void>) | undefined, exit: () => void): Promise<void> {
  try {
    await close?.();
  } finally {
    await flushOutput([process.stdout, process.stderr]);
    exit();
  }
}
