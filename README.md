# Looper

A small TUI tool that drives OpenCode through a sequence of agent steps, on a loop, until a step decides to stop.

## Install

```bash
bun install
ln -sfn "$PWD/bin/looper" "$HOME/.local/bin/looper"
```

`bin/looper` is the shell wrapper. It resolves through symlinks, so you can drop the symlink anywhere on your `PATH`.

## Use

In any project that has a `.local/looper/looper.yaml`:

```bash
looper                                  # open the TUI, press [g]o or [enter] to start (resumes by default)
looper --start                          # start immediately (resumes where the last run left off)
looper --fresh --start                  # start immediately, ignoring any saved checkpoint
looper --attach=http://127.0.0.1:4096   # connect to an existing OpenCode server
looper --wait=10                        # pause 10 minutes between iterations
looper --wait                           # pause for the previous iteration's runtime
looper 5                                # cap at 5 iterations (positional; default 100)
looper --help
```

CLI flags:

- `--attach[=url]` &mdash; connect to an existing opencode server instead of spawning one. Without a URL: tries `opencode.serverUrl` from `looper.yaml`, then `$OPENCODE_ATTACH_URL`, then `http://127.0.0.1:4096`.
- `--start` &mdash; skip the TUI start prompt and begin immediately.
- `--fresh` &mdash; ignore any saved checkpoint and start a new run from iteration 1, step 1.
- `--continue` &mdash; deprecated alias of `--start` (resuming is now the default).
- `--wait[=minutes]` &mdash; sleep between iterations. With `=N`, sleep N minutes. Without a value, sleep for the previous iteration's wall-clock duration.
- `max_iterations` (positional, default `100`) &mdash; stop after this many iterations if no step has written `.looper-stop`.

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
└── .local/looper/
    ├── looper.yaml          # required: step definitions
    ├── *.md                 # prompt files referenced from looper.yaml
    ├── .last-branch         # optional, written by your own prompts
    ├── .looper-stop         # written when a step decides to stop the loop
    ├── .looper-stop-after-iteration
    ├── .looper-resume-step.json   # legacy step-only checkpoint
    └── .looper-run.json           # resume pointer: iteration + step (+ live session while a step runs)
```

`looper.yaml` shape:

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

steps:
  build:
    name: Build                                  # display label (defaults to title-cased step key)
    agent: build                                 # opencode agent name (optional)
    model: openai/gpt-5.5                        # provider/model id (optional, falls back to agent default)
    variant: high                                # opencode agent variant (optional)
    prompt: build.md                             # path relative to .local/looper, or absolute
    prefix: "Working on $LANDO_TICKET.\n\n"      # optional text prepended to the prompt file content
    suffix: "Stop when CI passes."               # optional text appended to the prompt file content
    title: 30                                    # see "Session titles" below
  check-done:
    name: Check Done
    agent: sonny
    prompt: check-done.md
```

Per-step fields:

- `name` &mdash; display label shown in the TUI; defaults to the step key title-cased.
- `agent` &mdash; opencode agent name; omit to use opencode's default agent.
- `model` &mdash; `<provider>/<model>` id; omit to inherit from the agent.
- `variant` &mdash; opencode agent variant (e.g. `low` / `high`); omit for the agent's default.
- `prompt` &mdash; path to a markdown file; relative paths resolve against `.local/looper`.
- `prefix`, `suffix` &mdash; literal text wrapped around the prompt file content. Looper inserts a blank line between prefix/file/suffix unless they already end with a newline.
- `title` &mdash; see "Session titles" below.
- `context` &mdash; see "Prompt context" below.

### Prompt context

Every prompt looper sends (fresh step, recovery nudge, restart, retry, background continuation) is
prefixed with a small `<looper-context>` block giving the agent situational facts it would otherwise
have to rediscover: current datetime, repo dir, loop position, this step's timebox, an uncached VCS
delta, and the opencode session IDs of this iteration's already-finished steps (heading `Opencode
sessions from earlier steps this iteration:`). The block is read-only context, never instructions, and
never contains anything from a past iteration.

Control it with `context:`, at the top level of `looper.yaml` and/or per-step, both optional and
defaulting to everything on:

```yaml
context: false   # disable the block entirely for every step (shorthand for all six keys false)

steps:
  build:
    ...
    context:                # per-step override; each key defaults to true (or to the top-level value)
      vcsDelta: false        # e.g. skip the (possibly large) file-change list for this one step
      sessionIds: true
```

Valid keys: `datetime`, `repoDir`, `loopPosition`, `timebox`, `vcsDelta`, `sessionIds`. Each accepts a
boolean; an unknown key throws at load time naming the offending key. `context: false` (top level or
per-step) is shorthand for all six keys `false`; `context: true` or an absent `context:` leaves every
key at its default (`true`). A per-step key wins over the top-level value for that same key, which wins
over the default.

`vcsDelta` is a file list + counts (branch plus each changed file's `+adds/-dels` and status), not a
full diff, capped at 50 files; it is fetched fresh immediately before every prompt send and is
independent of the `vcsSummary` TUI panel &mdash; turning one off does not affect the other. If the VCS
lookup errors or hangs past its bound, looper logs one line and sends the prompt without that section
rather than blocking or failing the step.

### Session titles

Mark one step per iteration (typically your build step) with `title` to overwrite that step's opencode session title &mdash; and every later step's session title in the same iteration &mdash; with a description of what the agent actually worked on. The final title format is `"<step.name>: <generated description>"`.

- `title: true` &mdash; generate the title when the step finishes.
- `title: <integer seconds>` &mdash; generate the title *N seconds after the first assistant response* so it lands earlier in the TUI for long-running steps; falls back to the `title: true` behavior if the step ends sooner.
- `title: branch` &mdash; generate the title as soon as the branch watcher detects a switch to a non-trivial branch (anything other than `main`/`master`/`dev`/`develop`/`trunk`) during this step. Useful when the step itself creates a story branch &mdash; the new branch name becomes the primary title signal. Falls back to `title: 300` (snapshot 5min after first response, or at step end) if no branch transition is observed.

The description is reused for every subsequent step in the same iteration (e.g. `Review: <description>`), does not persist across iterations, and is not affected by skipped or failed steps. Set `title` on at most one step per iteration &mdash; later entries overwrite the description.

Set `opencode.title.{agent,model,variant}` in `looper.yaml` to control the title-generation session; any subset may be set. When `model` is unset, looper auto-picks a cheap model (opencode's `small_model`, else the cheapest non-reasoning model for the step's provider). Looper logs the model that ran each call (`[looper] title gen used agent=… model=…/… cost=…`).

By default looper starts its own OpenCode server. Set `opencode.serverUrl` to connect to an existing server instead. CLI `--attach=<url>` overrides the YAML value; `--attach` without a URL uses the YAML value, then `OPENCODE_ATTACH_URL`, then `http://127.0.0.1:4096`.

When attached to an existing server, looper checks the server's active location when the SDK exposes it and stops early if it points at a different project directory. If the server cannot provide location data, attach proceeds with the existing managed-agent validation.

Set `recovery.snapshots` to log safe session/message boundaries before retry/restart (`before-retry`) or before retry/restart/skip (`before-retry-and-skip`). This is diagnostic only: looper does not call opencode revert APIs or roll back user file changes automatically.

Steps run in declaration order. After each iteration the loop reloads `looper.yaml`, so you can edit it mid-run.

A step ends the loop by writing `.local/looper/.looper-stop` (with a reason string).

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
- `LOOPER_CONFIG_DIR` &mdash; override config dir (default: `$PWD/.local/looper`)
- `LOOPER_REPO_DIR` &mdash; override repo dir passed to OpenCode (default: `$PWD`)
- `LOOPER_DEBUG_EVENTS=1` &mdash; verbose OpenCode event logging
- `LOOPER_CONTINUATION_EXIT_GRACE_MS` &mdash; how long to wait after a step exits for a background-continuation record to appear (default: 30000)
