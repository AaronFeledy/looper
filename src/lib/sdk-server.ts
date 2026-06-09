import { spawn, type Subprocess } from "bun";

export type ServerHandle = {
  url: string;
  close: () => Promise<void>;
};

const LISTENING_RE = /opencode server listening on\s+(https?:\/\/\S+)/i;
const SPAWN_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 3_000;

function logServerDiagnostic(message: string): void {
  if (process.env.LOOPER_DEBUG_EVENTS === "1") console.error(`[looper] opencode server: ${message}`);
}

// SIGTERM, escalate to SIGKILL after the grace window, and await the exit so a
// server that ignores SIGTERM is never orphaned. Shared by shutdown and every
// startup-failure path.
async function terminateProcess(proc: Subprocess, label: string): Promise<void> {
  if (proc.exitCode !== null) return;
  try {
    proc.kill("SIGTERM");
  } catch (error) {
    logServerDiagnostic(`${label}: SIGTERM failed: ${formatError(error)}`);
  }
  const forceTimer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch (error) {
      logServerDiagnostic(`${label}: SIGKILL failed: ${formatError(error)}`);
    }
  }, SHUTDOWN_GRACE_MS);
  try {
    await proc.exited;
  } catch (error) {
    logServerDiagnostic(`${label}: exit wait failed: ${formatError(error)}`);
  } finally {
    clearTimeout(forceTimer);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk);
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return;
  for await (const _ of stream) {
    void _;
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("opencode server startup aborted");
}

async function captureListeningUrl(proc: Subprocess<"ignore", "pipe", "pipe">, signal?: AbortSignal): Promise<string> {
  const stdout = proc.stdout;
  if (!stdout) throw new Error("opencode serve produced no stdout");
  if (signal?.aborted) throw abortReason(signal);

  let url: string | null = null;
  let removeAbortListener: (() => void) | undefined;
  const exited = proc.exited.then((code) => {
    if (url === null) throw new Error(`opencode serve exited before listening (code ${code})`);
  });
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error(`opencode serve did not announce a URL within ${SPAWN_TIMEOUT_MS}ms`)), SPAWN_TIMEOUT_MS);
  });
  const scan = (async () => {
    for await (const line of readLines(stdout)) {
      const match = line.match(LISTENING_RE);
      if (match?.[1]) {
        url = match[1];
        return;
      }
    }
  })();
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        const onAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      })
    : undefined;

  try {
    await Promise.race(aborted ? [scan, exited, timeout, aborted] : [scan, exited, timeout]);
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    removeAbortListener?.();
  }

  if (url === null) throw new Error("opencode serve closed stdout without announcing a URL");

  return url;
}

async function spawnOpencodeServer(opencodeBin: string, signal?: AbortSignal): Promise<{ url: string; proc: Subprocess }> {
  if (signal?.aborted) throw abortReason(signal);
  const proc = spawn([opencodeBin, "serve", "--hostname=127.0.0.1", "--port=0"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Start draining stderr immediately; a noisy server can otherwise fill the pipe
  // and block before stdout prints the listening URL.
  void drain(proc.stderr).catch((error) => {
    logServerDiagnostic(`stderr drain failed: ${formatError(error)}`);
  });

  let url: string;
  try {
    url = await captureListeningUrl(proc, signal);
  } catch (error) {
    await terminateProcess(proc, "startup failed");
    throw error;
  }

  // Keep draining stdout or the OS pipe buffer fills and the server blocks on write.
  void drain(proc.stdout).catch((error) => {
    logServerDiagnostic(`stdout drain failed: ${formatError(error)}`);
  });

  return { url, proc };
}

export async function startOrAttachServer(options: {
  opencodeBin: string;
  attachUrl?: string;
  signal?: AbortSignal;
}): Promise<ServerHandle> {
  if (options.signal?.aborted) throw abortReason(options.signal);
  if (options.attachUrl !== undefined) {
    return {
      url: options.attachUrl,
      async close() {},
    };
  }

  const { url, proc } = await spawnOpencodeServer(options.opencodeBin, options.signal);

  return {
    url,
    async close() {
      await terminateProcess(proc, "shutdown");
    },
  };
}
