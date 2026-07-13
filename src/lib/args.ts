export type Options = {
  attach: boolean;
  attachUrl?: string;
  configDir?: string;
  fresh: boolean;
  init: boolean;
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
Usage: looper [init] [flags] [max_iterations]

Commands:
  init                Scaffold a starter config (looper.yml + example prompts) and exit.

Arguments:
  max_iterations      Stop after this many iterations if no step created .looper-stop. Default: 100.

Flags:
  --attach[=url]      Connect to an existing opencode server. Without a URL, uses looper.yml, OPENCODE_ATTACH_URL, or the local default.
  --config-dir=path   Use this directory for config, prompts, and state files. Overrides auto-detection and LOOPER_CONFIG_DIR.
  --start             Start immediately. Without this, the TUI waits for [g]o.
  --fresh             Ignore any saved checkpoint and start a new run from iteration 1, step 1.
  --continue          Deprecated alias of --start (resuming is now the default).
  --wait[=minutes]    Wait between iterations. Without minutes, wait for the previous iteration duration.
  -h, --help          Show this help.

By default looper resumes the previous run where it left off: it restores the iteration and step, and
reattaches to the in-progress opencode session if it is still active (otherwise it restarts that step).
Use --fresh to start over. A run that reaches max_iterations clears its checkpoint automatically.

Without --config-dir, looper looks for its config dir under \$PWD in this order: .looper, .local/looper, .local/.looper.
If none contain a config file it defaults to .looper. The config file is looper.yml (falling back to looper.yaml, .looper.yml, .looper.yaml).
State files (.looper-stop, .looper-resume-step.json, .looper-run.json, .last-branch) live in the same directory.
A step can stop the loop by creating .looper-stop in that directory.

Examples:
  looper init                      scaffold .looper/ in the current repo
  looper                           open the TUI, press [g] or [enter] to start
  looper --start                   start immediately, resuming any checkpoint
  looper --fresh --start 5         fresh run, start now, cap at 5 iterations
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
  let fresh = false;
  let init = false;
  let maxIterations = 100;
  let start = false;
  let waitProvided = false;
  let waitDuration: number | "execution-time" = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") {
      throw new HelpRequested(usage());
    }

    if (arg === "init") {
      init = true;
      continue;
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
      if (nextArg === undefined || nextArg.length === 0 || nextArg.startsWith("-")) throw new Error("--config-dir requires a path");
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

    if (arg === "--fresh") {
      fresh = true;
      continue;
    }

    if (arg === "--continue") {
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

  return { attach, attachUrl, ...(configDir !== undefined ? { configDir } : {}), fresh, init, maxIterations, start, waitProvided, waitDuration };
}

export function resolveAttachUrl(options: Options, configUrl: string | undefined, defaultAttachUrl: string): string | undefined {
  if (options.attachUrl !== undefined) return options.attachUrl;
  if (configUrl !== undefined) return configUrl;
  return options.attach ? defaultAttachUrl : undefined;
}
