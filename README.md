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
looper                                  # open the TUI, press [g]o or [enter] to start
looper --start                          # start immediately
looper --continue                       # resume from the last completed step
looper --attach=http://127.0.0.1:4096   # connect to an existing OpenCode server
looper --wait=10                        # pause 10 minutes between iterations
looper --wait                           # pause for the previous iteration's runtime
looper 5                                # cap at 5 iterations (positional; default 100)
looper --help
```

CLI flags:

- `--attach[=url]` &mdash; connect to an existing opencode server instead of spawning one. Without a URL: tries `opencode.serverUrl` from `looper.yaml`, then `$OPENCODE_ATTACH_URL`, then `http://127.0.0.1:4096`.
- `--start` &mdash; skip the TUI start prompt and begin immediately.
- `--continue` &mdash; start immediately at the last saved step checkpoint (`.looper-resume-step.json`).
- `--wait[=minutes]` &mdash; sleep between iterations. With `=N`, sleep N minutes. Without a value, sleep for the previous iteration's wall-clock duration.
- `max_iterations` (positional, default `100`) &mdash; stop after this many iterations if no step has written `.looper-stop`.

## Project layout in the consuming project

```
<your-project>/
└── .local/looper/
    ├── looper.yaml          # required: step definitions
    ├── *.md                 # prompt files referenced from looper.yaml
    ├── .last-branch         # optional, written by your own prompts
    ├── .looper-stop         # written when a step decides to stop the loop
    ├── .looper-stop-after-iteration
    └── .looper-resume-step.json
```

`looper.yaml` shape:

```yaml
opencode:
  serverUrl: http://127.0.0.1:4096  # optional: connect to an existing OpenCode server instead of spawning one
# attachUrl: http://127.0.0.1:4096  # top-level alias for opencode.serverUrl; used only if opencode.serverUrl is unset

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

### Session titles

Mark one step per iteration (typically your build step) with `title` to overwrite that step's opencode session title &mdash; and every later step's session title in the same iteration &mdash; with a description of what the agent actually worked on. The final title format is `"<step.name>: <generated description>"`.

- `title: true` &mdash; generate the title when the step finishes.
- `title: <integer seconds>` &mdash; generate the title *N seconds after the first assistant response* so it lands earlier in the TUI for long-running steps; falls back to the `title: true` behavior if the step ends sooner.
- `title: branch` &mdash; generate the title as soon as the branch watcher detects a switch to a non-trivial branch (anything other than `main`/`master`/`dev`/`develop`/`trunk`) during this step. Useful when the step itself creates a story branch &mdash; the new branch name becomes the primary title signal. Falls back to `title: 300` (snapshot 5min after first response, or at step end) if no branch transition is observed.

The description is reused for every subsequent step in the same iteration (e.g. `Review: <description>`), does not persist across iterations, and is not affected by skipped or failed steps. Set `title` on at most one step per iteration &mdash; later entries overwrite the description.

Title generation runs against the opencode server's default agent + model; looper logs which one it used. Switch the default to something cheap if you don't want to pay for it.

By default looper starts its own OpenCode server. Set `opencode.serverUrl` to connect to an existing server instead. CLI `--attach=<url>` overrides the YAML value; `--attach` without a URL uses the YAML value, then `OPENCODE_ATTACH_URL`, then `http://127.0.0.1:4096`.

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
