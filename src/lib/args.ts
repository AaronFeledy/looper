export type Options = {
  attach: boolean;
  attachUrl?: string;
  configDir?: string;
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
Usage: looper [--attach[=url]] [--config-dir=path|--config-dir path] [--start|--continue] [--wait[=minutes]|--wait minutes] [max_iterations]

Flags:
  --attach[=url]      Connect to an existing opencode server. Without a URL, uses looper.yml, OPENCODE_ATTACH_URL, or the local default.
  --config-dir=path   Use this directory for config, prompts, and state files. Overrides auto-detection and LOOPER_CONFIG_DIR.
  --start             Start immediately. Without this, the TUI waits for [g]o.
  --continue          Start immediately from the last saved step checkpoint.
  --wait[=minutes]    Wait between iterations. Without minutes, wait for the previous iteration duration.

Without --config-dir, looper looks for its config dir under \$PWD in this order: .looper, .local/looper, .local/.looper.
If none contain a config file it defaults to .looper. The config file is looper.yml (falling back to looper.yaml, .looper.yml, .looper.yaml).
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
  let configDir: string | undefined;
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

    if (arg === "--config-dir") {
      const nextArg = argv[index + 1];
      if (nextArg === undefined || nextArg.startsWith("-")) throw new Error("--config-dir requires a path");
      configDir = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--config-dir=")) {
      configDir = arg.slice("--config-dir=".length);
      if (configDir.length === 0) throw new Error("config dir cannot be empty");
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

  return { attach, attachUrl, ...(configDir !== undefined ? { configDir } : {}), continueFromLastStep, maxIterations, start, waitProvided, waitDuration };
}

export function resolveAttachUrl(options: Options, configUrl: string | undefined, defaultAttachUrl: string): string | undefined {
  if (options.attachUrl !== undefined) return options.attachUrl;
  if (configUrl !== undefined) return configUrl;
  return options.attach ? defaultAttachUrl : undefined;
}
