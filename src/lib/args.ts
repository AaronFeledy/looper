import { isValidPhase, type StoryPhase } from "./story-state-files.ts";

export type SignalCommand =
  | { readonly kind: "adjudicate"; readonly reason: string }
  | { readonly kind: "stop"; readonly reason: string }
  | { readonly kind: "stop-after-iteration"; readonly reason: string }
  | { readonly kind: "story-phase"; readonly phase: StoryPhase; readonly story?: string };

export type Command =
  | { readonly kind: "run" }
  | { readonly kind: "init" }
  | { readonly kind: "signal"; readonly signal: SignalCommand };

export type Options = {
  readonly attach: boolean;
  readonly attachUrl?: string;
  readonly command: Command;
  readonly configDir?: string;
  readonly fresh: boolean;
  readonly maxIterations: number;
  readonly start: boolean;
  readonly waitProvided: boolean;
  readonly waitDuration: number | "execution-time";
};

export class HelpRequested extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelpRequested";
  }
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export function usage() {
  return `Looper - iterative OpenCode step runner
Usage: looper [init | signal <kind>] [flags] [max_iterations]

Commands:
  init                Scaffold a starter config (looper.yml + example prompts) and exit.
  signal adjudicate --reason <text>
                      Request adjudication by writing the adjudication marker.
  signal stop --reason <text>
                      Request an immediate stop.
  signal stop-after-iteration --reason <text>
                      Request a stop after the current iteration.
  signal story-phase <phase> [--story <ID>]
                      Set a story phase; defaults the story ID from the current branch.

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
  looper signal stop --reason "operator request"
  looper signal story-phase verified --story US-074
  looper                           open the TUI, press [g] or [enter] to start
  looper --start                   start immediately, resuming any checkpoint
  looper --fresh --start 5         fresh run, start now, cap at 5 iterations
`;
}

function parsePositiveInteger(value: string, label: string, { allowZero = false }: { allowZero?: boolean } = {}) {
  if (!/^\d+$/.test(value)) throw new UsageError(`${label} must be a non-negative integer: ${value}`);
  const parsed = Number.parseInt(value, 10);
  if (!allowZero && parsed === 0) throw new UsageError(`${label} must be greater than zero: ${value}`);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${label} is too large: ${value}`);
  return parsed;
}

type GlobalArgs = {
  readonly args: readonly string[];
  readonly configDir?: string;
};

function parseGlobalArgs(argv: readonly string[]): GlobalArgs {
  const args: string[] = [];
  let configDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") throw new HelpRequested(usage());
    if (arg === "--config-dir") {
      const nextArg = argv[index + 1];
      if (nextArg === undefined || nextArg.length === 0 || nextArg.startsWith("-")) throw new UsageError("--config-dir requires a path");
      configDir = nextArg;
      index += 1;
      continue;
    }
    if (arg.startsWith("--config-dir=")) {
      configDir = arg.slice("--config-dir=".length);
      if (configDir.length === 0) throw new UsageError("config dir cannot be empty");
      continue;
    }
    args.push(arg);
  }
  return { args, ...(configDir !== undefined ? { configDir } : {}) };
}

function parseSignalCommand(args: readonly string[]): SignalCommand {
  const positionals: string[] = [];
  let reason: string | undefined;
  let story: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--reason" || arg.startsWith("--reason=")) {
      if (reason !== undefined) throw new UsageError("--reason may only be provided once");
      const value = arg === "--reason" ? args[index + 1] : arg.slice("--reason=".length);
      if (value === undefined || value.trim().length === 0 || value.startsWith("-")) throw new UsageError("--reason requires text");
      reason = value;
      if (arg === "--reason") index += 1;
      continue;
    }
    if (arg === "--story" || arg.startsWith("--story=")) {
      if (story !== undefined) throw new UsageError("--story may only be provided once");
      const value = arg === "--story" ? args[index + 1] : arg.slice("--story=".length);
      if (value === undefined || value.trim().length === 0 || value.startsWith("-")) throw new UsageError("--story requires an ID");
      story = value.trim();
      if (arg === "--story") index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`flag '${arg}' is not valid for signal`);
    positionals.push(arg);
  }

  const kind = positionals[0];
  if (kind === undefined) throw new UsageError("signal requires a kind");
  if (kind === "story-phase") {
    const phase = positionals[1];
    if (phase === undefined) throw new UsageError("signal story-phase requires a phase");
    if (!isValidPhase(phase)) throw new UsageError(`invalid story phase '${phase}'`);
    if (positionals.length !== 2) throw new UsageError(`unexpected signal argument '${positionals[2]}'`);
    if (reason !== undefined) throw new UsageError("--reason is not valid for signal story-phase");
    return { kind, phase, ...(story !== undefined ? { story } : {}) };
  }
  if (kind !== "adjudicate" && kind !== "stop" && kind !== "stop-after-iteration") {
    throw new UsageError(`unknown signal '${kind}'`);
  }
  if (positionals.length !== 1) throw new UsageError(`unexpected signal argument '${positionals[1]}'`);
  if (reason === undefined) throw new UsageError(`signal ${kind} requires --reason <text>`);
  if (story !== undefined) throw new UsageError(`--story is not valid for signal ${kind}`);
  return { kind, reason };
}

export function parseArgs(argv: readonly string[]): Options {
  const globalArgs = parseGlobalArgs(argv);
  const commandIndex = globalArgs.args.findIndex((arg) => arg === "init" || arg === "signal");
  const commandToken = commandIndex === -1 ? undefined : globalArgs.args[commandIndex];
  if (commandToken === "signal") {
    const signalArgs = [...globalArgs.args.slice(0, commandIndex), ...globalArgs.args.slice(commandIndex + 1)];
    return {
      attach: false,
      command: { kind: "signal", signal: parseSignalCommand(signalArgs) },
      ...(globalArgs.configDir !== undefined ? { configDir: globalArgs.configDir } : {}),
      fresh: false,
      maxIterations: 100,
      start: false,
      waitProvided: false,
      waitDuration: 0,
    };
  }

  let attach = false;
  let attachUrl: string | undefined;
  let fresh = false;
  let maxIterations = 100;
  let start = false;
  let waitProvided = false;
  let waitDuration: number | "execution-time" = 0;
  const runArgs = commandToken === "init" ? [...globalArgs.args.slice(0, commandIndex), ...globalArgs.args.slice(commandIndex + 1)] : globalArgs.args;

  for (let index = 0; index < runArgs.length; index += 1) {
    const arg = runArgs[index];
    if (arg === undefined) continue;
    if (arg === "--attach") {
      attach = true;
      continue;
    }

    if (arg.startsWith("--attach=")) {
      attach = true;
      attachUrl = arg.slice("--attach=".length);
      if (attachUrl.length === 0) throw new UsageError("attach URL cannot be empty");
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
      const nextArg = runArgs[index + 1];
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

    throw new UsageError(`unknown argument '${arg}'`);
  }

  return {
    attach,
    attachUrl,
    command: commandToken === "init" ? { kind: "init" } : { kind: "run" },
    ...(globalArgs.configDir !== undefined ? { configDir: globalArgs.configDir } : {}),
    fresh,
    maxIterations,
    start,
    waitProvided,
    waitDuration,
  };
}

export function resolveAttachUrl(options: Options, configUrl: string | undefined, defaultAttachUrl: string): string | undefined {
  if (options.attachUrl !== undefined) return options.attachUrl;
  if (configUrl !== undefined) return configUrl;
  return options.attach ? defaultAttachUrl : undefined;
}
