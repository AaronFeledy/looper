import { spawn, type Subprocess } from "bun";

export type ServerHandle = {
  url: string;
  close: () => Promise<void>;
};

const LISTENING_RE = /opencode server listening on\s+(https?:\/\/\S+)/i;
const SPAWN_TIMEOUT_MS = 15_000;

function logServerDiagnostic(message: string): void {
  if (process.env.LOOPER_DEBUG_EVENTS === "1") console.error(`[looper] opencode server: ${message}`);
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
        const onAbort = () => {
          proc.kill("SIGTERM");
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      })
    : undefined;

  try {
    await Promise.race(aborted ? [scan, exited, timeout, aborted] : [scan, exited, timeout]);
  } catch (error) {
    proc.kill("SIGTERM");
    throw error;
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    removeAbortListener?.();
  }

  if (url === null) {
    proc.kill("SIGTERM");
    throw new Error("opencode serve closed stdout without announcing a URL");
  }

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

  const url = await captureListeningUrl(proc, signal);

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
      if (proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      const forceTimer = setTimeout(() => proc.kill("SIGKILL"), 3000);
      await proc.exited.catch((error) => {
        logServerDiagnostic(`shutdown wait failed: ${formatError(error)}`);
      });
      clearTimeout(forceTimer);
    },
  };
}
