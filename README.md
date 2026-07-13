# Looper

A small TUI tool that drives OpenCode through a sequence of agent steps, on a loop, until a step decides to stop.

## Install

```bash
bun install
ln -sfn "$PWD/bin/looper" "$HOME/.local/bin/looper"
```

`bin/looper` is the shell wrapper. It resolves through symlinks, so you can drop the symlink anywhere on your `PATH`.

## Use

In any project that has a Looper config file:

```bash
looper init                             # scaffold .looper/ with a starter looper.yml + example prompts
looper                                  # open the TUI, press [g]o or [enter] to start (resumes by default)
looper --start                          # start immediately (resumes where the last run left off)
looper --fresh --start                  # start immediately, ignoring any saved checkpoint
looper --attach=http://127.0.0.1:4096   # connect to an existing OpenCode server
looper --config-dir=.local/looper       # use a specific config/state directory
looper --wait=10                        # pause 10 minutes between iterations
looper --wait                           # pause for the previous iteration's runtime
looper 5                                # cap at 5 iterations (positional; default 100)
looper --help
```

Press `?` in the TUI for a keybinding overlay.

CLI flags:

- `init` &mdash; scaffold the config directory (`looper.yml`, `work.md`, `check-done.md`) and exit. Refuses to overwrite an existing config.
- `--attach[=url]` &mdash; connect to an existing opencode server instead of spawning one. Without a URL: tries `opencode.serverUrl` from the config file, then `$OPENCODE_ATTACH_URL`, then `http://127.0.0.1:4096`.
- `--config-dir=path` / `--config-dir path` &mdash; use this directory for config, prompts, and state files. Overrides auto-detection and `$LOOPER_CONFIG_DIR`.
- `--start` &mdash; skip the TUI start prompt and begin immediately.
- `--fresh` &mdash; ignore any saved checkpoint and start a new run from iteration 1, step 1.
- `--continue` &mdash; deprecated alias of `--start` (resuming is now the default).
- `--wait[=minutes]` &mdash; sleep between iterations. With `=N`, sleep N minutes. Without a value, sleep for the previous iteration's wall-clock duration.
- `max_iterations` (positional, default `100`) &mdash; stop after this many iterations if no step has written `.looper-stop`.

Without `--config-dir`, looper looks under `$PWD` in this order: `.looper`, `.local/looper`, `.local/.looper`. The first directory that already contains a config file wins; if none do, looper defaults to `.looper`. Within that directory, config file resolution prefers `looper.yml`, then `looper.yaml`, `.looper.yml`, `.looper.yaml`.

## Resuming

Looper resumes the previous run by default. If you quit (or it stops) mid-run, the next start picks up at the
same iteration and step. While a step is running, looper records its opencode session in `.looper-run.json`; on
resume it reattaches to that session if it is still generating, otherwise it restarts the step in a fresh session.
Manual recovery nudge is the exception: when the failed session is known and already idle, nudge sends its prompt
to that existing session instead of creating a new one.
A run that reaches `max_iterations` clears its checkpoint, so the next start begins a new run. Pass `--fresh` to
ignore the checkpoint and start over from iteration 1.

## History

Press `h` in the TUI to browse the output of previous iterations from the current run. Use `Left`/`Right` to move
between iterations, `Up`/`Down` to pick a step, and `Tab` to focus the output pane and scroll. Step output is
refetched from opencode on demand; history is kept in memory for the current run only and is not written to disk.

## Project layout in the consuming project

```
<your-project>/
└── .looper/                 # default; see config-dir auto-detection above
    ├── looper.yml           # required: step definitions
    ├── *.md                 # prompt files referenced from looper.yml / looper.yaml
    ├── .last-branch         # optional, written by your own prompts
    ├── .looper-stop         # written when a step decides to stop the loop
    ├── .looper-stop-after-iteration
    ├── .looper-resume-step.json   # legacy step-only checkpoint
    └── .looper-run.json           # resume pointer: iteration + step (+ live session while a step runs)
```

`looper.yml` / `looper.yaml` shape:

```yaml
opencode:
  serverUrl: http://127.0.0.1:4096  # optional: connect to an existing OpenCode server instead of spawning one
  title:                            # optional: override agent/model/variant used by the title-generation session
    agent: build
    model: openai/gpt-5.5-nano
    variant: low
# attachUrl: http://127.0.0.1:4096  # top-level alias for opencode.serverUrl; used only if opencode.serverUrl is unset
recovery:
  snapshots: false                  # false | before-retry | before-retry-and-skip; logs safe recovery boundaries only
timeout: 60m                        # optional default per-step timeout; integer minutes or duration string: 30s, 60m, 1h
permissionPolicy:                   # optional global auto-reply policy for OpenCode permission prompts
  "*": ask                          # ask | always | once | reject
questionPolicy: ask                  # optional global policy for OpenCode question prompts: ask | reject
useSessionIdle: false                # optional: use session idle status in recovery/reattach checks
vcsSummary: false                    # optional: capture per-step VCS snapshots for the TUI summary panel
validateResources: false             # optional: validate configured agents exist during startup
prd: spec/beta-1                     # optional PRD directory; relative paths resolve from the repo dir
context: true                        # optional; see "Prompt context" below

steps:
  build:
    name: Build                                  # display label (defaults to title-cased step key)
    agent: build                                 # opencode agent name (optional)
    model: openai/gpt-5.5                        # provider/model id (optional, falls back to agent default)
    variant: high                                # opencode agent variant (optional; null disables)
    prompt: build.md                             # path relative to the config directory, or absolute
    prefix: "Working on $LANDO_TICKET.\n\n"      # optional text prepended to the prompt file content
    suffix: "Stop when CI passes."               # optional text appended to the prompt file content
    args: ["--example"]                          # optional string args kept with step config for prompts/integrations
    timeout: 45m                                  # optional per-step override; integer minutes or 30s/60m/1h
    permissionPolicy:                            # optional per-step override/extension of global permissionPolicy
      edit: always
    questionPolicy: reject                       # optional per-step override: ask | reject
    title: 30                                    # see "Session titles" below
    context:
      vcsDelta: false                            # optional per-step prompt-context override
  check-done:
    name: Check Done
    agent: sonny
    prompt: check-done.md
```

Per-step fields:

- `name` &mdash; display label shown in the TUI; defaults to the step key title-cased.
- `agent` &mdash; opencode agent name; omit to use opencode's default agent.
- `model` &mdash; `<provider>/<model>` id; omit to inherit from the agent.
- `variant` &mdash; opencode agent variant (e.g. `low` / `high`); omit for the agent's default. Use `null` to force-disable reasoning variants (opencode's `"default"` sentinel). If a named variant is not listed for the resolved model, looper omits it and logs a note instead of failing the step.
- `prompt` &mdash; path to a markdown file; relative paths resolve against the config directory.
- `prefix`, `suffix` &mdash; literal text wrapped around the prompt file content. Looper inserts a blank line between prefix/file/suffix unless they already end with a newline.
- `args` &mdash; optional string array retained with step config for prompt/integration use.
- `timeout` &mdash; optional per-step timeout. Numbers are minutes; strings accept `s`, `m`, or `h` suffixes.
- `permissionPolicy` &mdash; optional per-step OpenCode permission auto-reply policy. Actions are `ask`, `always`, `once`, or `reject`; `*` is the wildcard key at the global level.
- `questionPolicy` &mdash; optional per-step OpenCode question policy: `ask` or `reject`.

When a permission or question is left pending (policy `ask`, or no policy), the TUI shows a "waiting on you" banner above the footer until it is answered from an attached opencode client.

- `title` &mdash; see "Session titles" below.
- `context` &mdash; see "Prompt context" below.

### Prompt context

Every prompt looper sends (fresh step, recovery nudge, restart, retry, background continuation) is
prefixed with a small `<looper-context>` block giving the agent situational facts it would otherwise
have to rediscover: current datetime, repo dir, loop position, this step's timebox, an uncached VCS
delta, optional PRD progress, and the opencode session IDs of this iteration's already-finished steps (heading `Opencode
sessions from earlier steps this iteration:`). The block is read-only context, never instructions, and
never contains anything from a past iteration.

Control it with `context:`, at the top level of the config file and/or per-step, both optional and
defaulting to everything on:

```yaml
context: false   # disable the block entirely for every step (shorthand for all seven keys false)

steps:
  build:
    ...
    context:                # per-step override; each key defaults to true (or to the top-level value)
      vcsDelta: false        # e.g. skip the (possibly large) file-change list for this one step
      prd: true
      sessionIds: true
```

Valid keys: `datetime`, `repoDir`, `loopPosition`, `timebox`, `vcsDelta`, `sessionIds`, `prd`. Each accepts a
boolean; an unknown key throws at load time naming the offending key. `context: false` (top level or
per-step) is shorthand for all seven keys `false`; `context: true` or an absent `context:` leaves every
key at its default (`true`). A per-step key wins over the top-level value for that same key, which wins
over the default.

`vcsDelta` is a file list + counts, not a full diff. It includes both committed branch delta vs the
resolved base branch and uncommitted working-tree changes, labels those groups separately, and caps at
50 files / about 3800 context characters; it is fetched fresh immediately before every prompt send and is
independent of `vcsSummary` per-step snapshots for the TUI panel &mdash; turning one off does not affect the other. If the VCS
lookup errors or hangs past its bound, looper logs one line and sends the prompt without that section
rather than blocking or failing the step.

`prd` is included only when top-level `prd:` is configured and `prd.json` can be read. It renders a one-line
summary like `PRD: 12 of 41 user stories passing (29 remaining)`. Disable it independently with
`context.prd: false`.

### PRD progress

Set top-level `prd:` to the directory containing `prd.json` to enable PRD progress reporting. Relative paths
resolve against the repo dir, not the config dir:

```yaml
prd: spec/beta-1
```

When configured, the TUI shows a PRD progress panel and the prompt context can include the same progress line.
Looper polls `prd.json` every few seconds and reports parse/read errors in the panel instead of failing the run.

### Session titles

Mark one step per iteration (typically your build step) with `title` to overwrite that step's opencode session title &mdash; and every later step's session title in the same iteration &mdash; with a description of what the agent actually worked on. The final title format is `"<step.name>: <generated description>"`.

- `title: true` &mdash; generate the title when the step finishes.
- `title: <integer seconds>` &mdash; generate the title *N seconds after the first assistant response* so it lands earlier in the TUI for long-running steps; falls back to the `title: true` behavior if the step ends sooner.
- `title: branch` &mdash; generate the title as soon as the branch watcher detects a switch to a non-trivial branch (anything other than `main`/`master`/`dev`/`develop`/`trunk`) during this step. Useful when the step itself creates a story branch &mdash; the new branch name becomes the primary title signal. Falls back to `title: 300` (snapshot 5min after first response, or at step end) if no branch transition is observed.

The description is reused for every subsequent step in the same iteration (e.g. `Review: <description>`), does not persist across iterations, and is not affected by skipped or failed steps. Set `title` on at most one step per iteration &mdash; later entries overwrite the description.

Set `opencode.title.{agent,model,variant}` in the config file to control the title-generation session; any subset may be set. When `agent` is unset, looper uses its managed hidden `looper-title` agent, which has all tools denied. When `model` is unset, looper auto-picks a cheap model: opencode's `small_model`, else the cheapest non-reasoning model for the step's provider, else the cheapest reasoning model when the provider has no non-reasoning option. Looper logs the model that ran each call (`[looper] title gen used agent=… model=…/… cost=…`).

Looper writes the managed `looper-title` agent into opencode's global agent directory at startup (`$XDG_CONFIG_HOME/opencode/agent`, else `~/.config/opencode/agent`). It only overwrites a file carrying looper's managed marker and leaves user-authored files alone. In attach mode, an already-running opencode server may not have loaded a freshly written managed agent yet; looper validates this and asks you to restart the server if required.

By default looper starts its own OpenCode server. Set `opencode.serverUrl` to connect to an existing server instead. CLI `--attach=<url>` overrides the config value; `--attach` without a URL uses the config value, then `OPENCODE_ATTACH_URL`, then `http://127.0.0.1:4096`.

When attached to an existing server, looper checks the server's active location when the SDK exposes it and stops early if it points at a different project directory. If the server cannot provide location data, attach proceeds with the existing managed-agent validation.

Set `recovery.snapshots` to log safe session/message boundaries before retry/restart (`before-retry`) or before retry/restart/skip (`before-retry-and-skip`). This is diagnostic only: looper does not call opencode revert APIs or roll back user file changes automatically.

Steps run in declaration order. After each iteration the loop reloads the config file, so you can edit it mid-run.

A step ends the loop by writing `.looper-stop` in the config directory (with a reason string).

## Develop

```bash
bun install
bun run typecheck
bun test                  # runs everything (~50s end-to-end)
```

The e2e test (`test/e2e.test.ts`) drives a real OpenCode server with `openai/gpt-5.5` against two trivial prompts, costs roughly free, and self-skips if `opencode` is not on `PATH`. Override with:

- `OPENCODE_BIN=/path/to/opencode`
- `LOOPER_E2E_MODEL=anthropic/claude-haiku-4-5`
- `LOOPER_E2E_KEEP=1` &mdash; keep the scratch dir under `test/.tmp` for debugging

## Environment

- `OPENCODE_BIN` &mdash; opencode binary (default: `opencode`)
- `OPENCODE_ATTACH_URL` &mdash; default URL for `--attach`
- `LOOPER_CONFIG_DIR` &mdash; override config dir (default: auto-detect `.looper`, `.local/looper`, `.local/.looper`; otherwise `$PWD/.looper`)
- `LOOPER_REPO_DIR` &mdash; override repo dir passed to OpenCode (default: `$PWD`)
- `LOOPER_DEBUG_EVENTS=1` &mdash; verbose OpenCode event logging
- `LOOPER_ATTACH_VALIDATION_TIMEOUT_MS` &mdash; timeout for attach-mode managed-resource validation (default: `10000`)
- `LOOPER_CONTINUATION_EXIT_GRACE_MS` &mdash; how long to wait after a step exits for a background-continuation record to appear (default: 30000)
- `LOOPER_EVENT_WATCHDOG_POLL_MS` &mdash; event-stream watchdog poll interval (default: `15000`)
- `LOOPER_EVENT_STALL_MS` &mdash; event-stream idle threshold before probing session status (default: `45000`)
- `LOOPER_EVENT_RESUBSCRIBE_BACKOFF_MS` &mdash; minimum delay between event-stream reconnect attempts (default: `1000`)
- `LOOPER_STOP_SESSION_POLL_MS` &mdash; poll interval while confirming a prior session stopped (default: `250`)
- `LOOPER_STOP_SESSION_TIMEOUT_MS` &mdash; timeout while confirming a prior session stopped (default: `10000`)
- `LOOPER_SERVER_RECOVERY_MAX_WAIT_MS` &mdash; maximum wait while recovering a server/session status probe (default: `600000`)
- `LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS` &mdash; initial server recovery backoff (default: `2000`)
- `LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS` &mdash; maximum server recovery backoff (default: `30000`)
- `LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS` &mdash; per-probe server recovery timeout (default: `10000`)
- `LOOPER_PROMPT_VCS_TIMEOUT_MS` &mdash; timeout for prompt-context VCS lookup (default: `5000`)
- `LOOPER_INHERITED_TITLE_DELAY_MS` &mdash; delay before applying an inherited title to later-step sessions (default: `5000`)
- `LOOPER_TITLE_GEN_TIMEOUT_MS` &mdash; timeout for title generation sessions (default: `60000`)
