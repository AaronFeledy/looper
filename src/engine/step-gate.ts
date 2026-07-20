import { gateScriptTimeoutMs } from "../config/tunables.ts";
import type { GateConfig } from "../lib/config.ts";
import { comparePhase, type StoryPhase } from "../lib/story-state-files.ts";

export type GateScriptResult = {
  readonly ran: boolean;
  readonly exitCode?: number;
  readonly error?: string;
};

export type GateInputs = {
  readonly gate: GateConfig;
  readonly branch: string | undefined;
  readonly storyId: string | undefined;
  readonly passes: boolean | undefined;
  readonly phase: StoryPhase | undefined;
  readonly scriptResult?: GateScriptResult;
};

export type GateDecision = { readonly pass: true } | { readonly pass: false; readonly reason: string };

export function evaluateGate(inputs: GateInputs): GateDecision {
  if (inputs.gate.branch === "story" && inputs.storyId === undefined) {
    return { pass: false, reason: "gate: branch is not a story branch" };
  }
  if (inputs.gate.branch === "main" && inputs.branch !== "main") {
    return { pass: false, reason: "gate: branch is not main" };
  }

  if (inputs.gate.prdPasses === true) {
    if (inputs.storyId === undefined) return { pass: false, reason: "gate: prdPasses requires a story id" };
    if (inputs.passes === undefined) return { pass: false, reason: `gate: prdPasses is unavailable for ${inputs.storyId}` };
    if (!inputs.passes) return { pass: false, reason: `gate: prdPasses is false for ${inputs.storyId}` };
  }

  if (inputs.gate.phase !== undefined) {
    const currentPhase = inputs.phase ?? "building";
    if (comparePhase(currentPhase, inputs.gate.phase) < 0) {
      return { pass: false, reason: `gate: phase ${currentPhase} is before ${inputs.gate.phase}` };
    }
  }

  if (inputs.gate.script !== undefined) {
    if (inputs.scriptResult === undefined) return { pass: false, reason: "gate: script did not run" };
    if (!inputs.scriptResult.ran) {
      return { pass: false, reason: `gate: script failed: ${inputs.scriptResult.error ?? "unknown error"}` };
    }
    if (inputs.scriptResult.exitCode === undefined) {
      return { pass: false, reason: "gate: script did not report an exit code" };
    }
    if (inputs.scriptResult.exitCode !== 0) {
      return { pass: false, reason: `gate: script exited with code ${inputs.scriptResult.exitCode}` };
    }
  }

  return { pass: true };
}

type GateScriptOptions = {
  readonly repoDir: string;
  readonly branch?: string;
  readonly storyId?: string;
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
