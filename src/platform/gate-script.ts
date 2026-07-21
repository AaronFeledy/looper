import { gateScriptTimeoutMs } from "../config/tunables.ts";

export type GateScriptResult = {
  readonly ran: boolean;
  readonly exitCode?: number;
  readonly error?: string;
};

export type GateScriptOptions = {
  readonly repoDir: string;
  readonly branch?: string;
  readonly storyId?: string;
  readonly prdDir?: string;
  readonly prdIndex?: string;
  readonly prdProgress?: string;
  readonly timeoutMs?: number;
};

const TERMINATION_GRACE_MS = 100;

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
}

export async function runGateScript(script: string, options: GateScriptOptions): Promise<GateScriptResult> {
  const timeoutMs = options.timeoutMs ?? gateScriptTimeoutMs();
  let subprocess: ReturnType<typeof Bun.spawn>;
  try {
    subprocess = Bun.spawn(["bash", "-c", script], {
      cwd: options.repoDir,
      detached: true,
      env: {
        ...process.env,
        LOOPER_BRANCH: options.branch ?? "",
        LOOPER_STORY_ID: options.storyId ?? "",
        LOOPER_PRD_DIR: options.prdDir ?? "",
        LOOPER_PRD_INDEX: options.prdIndex ?? "",
        LOOPER_PRD_PROGRESS: options.prdProgress ?? "",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (error) {
    if (error instanceof Error) return { ran: false, error: `spawn failed: ${error.message}` };
    throw error;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    subprocess.exited.then((exitCode) => ({ kind: "exited", exitCode }) as const),
    new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

  if (outcome.kind === "exited") return { ran: true, exitCode: outcome.exitCode };

  signalProcessGroup(subprocess.pid, "SIGTERM");
  await Bun.sleep(TERMINATION_GRACE_MS);
  if (processGroupExists(subprocess.pid)) signalProcessGroup(subprocess.pid, "SIGKILL");
  await subprocess.exited;
  return { ran: false, error: `timed out after ${timeoutMs}ms` };
}
