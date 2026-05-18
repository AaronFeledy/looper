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
looper          # opens the TUI, press [g]o to start
looper --start  # start immediately
looper --continue   # resume from the last completed step
looper --help
```

Run `looper --help` for the full flag list (attach to an existing OpenCode server, set iteration cap, wait between iterations, etc.).

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
steps:
  build:
    name: Build
    agent: build              # opencode agent name
    model: openai/gpt-5.5     # provider/model id (optional, falls back to agent default)
    variant: high             # opencode agent variant (optional)
    prompt: build.md          # path relative to .local/looper, or absolute
  check-done:
    name: Check Done
    agent: sonny
    prompt: check-done.md
```

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
