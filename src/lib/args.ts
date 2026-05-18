export type Options = {
  attach: boolean;
  attachUrl?: string;
  continueFromLastStep: boolean;
  maxIterations: number;
  start: boolean;
  waitProvided: boolean;
  waitDuration: number | "execution-time";
};

export class HelpRequested extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelpRequested";
  }
}

export function usage() {
  return `Looper - iterative OpenCode step runner
Usage: looper [--attach[=url]] [--start|--continue] [--wait[=minutes]|--wait minutes] [max_iterations]

Flags:
  --attach[=url]   Pass --attach to opencode. Without a URL, uses OPENCODE_ATTACH_URL or the local default.
  --start          Start immediately. Without this, the TUI waits for [g]o.
  --continue       Start immediately from the last saved step checkpoint.
  --wait[=minutes] Wait between iterations. Without minutes, wait for the previous iteration duration.

Looper looks for its config and prompts under \$PWD/.local/looper/looper.yaml.
State files (.looper-stop, .looper-resume-step.json, .last-branch) live in the same directory.
A step can stop the loop by creating .looper-stop in that directory.
`;
}

function parsePositiveInteger(value: string, label: string, { allowZero = false }: { allowZero?: boolean } = {}) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer: ${value}`);
  const parsed = Number.parseInt(value, 10);
  if (!allowZero && parsed === 0) throw new Error(`${label} must be greater than zero: ${value}`);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is too large: ${value}`);
  return parsed;
}

export function parseArgs(argv: string[]): Options {
  let attach = false;
  let attachUrl: string | undefined;
  let continueFromLastStep = false;
  let maxIterations = 100;
  let start = false;
  let waitProvided = false;
  let waitDuration: number | "execution-time" = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") {
      throw new HelpRequested(usage());
    }

    if (arg === "--attach") {
      attach = true;
      continue;
    }

    if (arg.startsWith("--attach=")) {
      attach = true;
      attachUrl = arg.slice("--attach=".length);
      if (attachUrl.length === 0) throw new Error("attach URL cannot be empty");
      continue;
    }

    if (arg === "--start") {
      start = true;
      continue;
    }

    if (arg === "--continue") {
      continueFromLastStep = true;
      start = true;
      continue;
    }

    if (arg === "--wait") {
      waitProvided = true;
      const nextArg = argv[index + 1];
      if (nextArg !== undefined && /^\d+$/.test(nextArg)) {
        waitDuration = parsePositiveInteger(nextArg, "wait duration", { allowZero: true });
        index += 1;
      } else {
        waitDuration = "execution-time";
      }
      continue;
    }

    if (arg.startsWith("--wait=")) {
      waitProvided = true;
      waitDuration = parsePositiveInteger(arg.slice("--wait=".length), "wait duration", { allowZero: true });
      continue;
    }

    if (/^\d+$/.test(arg)) {
      maxIterations = parsePositiveInteger(arg, "max iterations");
      continue;
    }

    throw new Error(`unknown argument '${arg}'`);
  }

  return { attach, attachUrl, continueFromLastStep, maxIterations, start, waitProvided, waitDuration };
}
