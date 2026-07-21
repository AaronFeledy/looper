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
- `signal <kind>` &mdash; write a state file directly, without a looper process running. See "Signals" below.
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
    ├── .looper-run.json           # resume pointer: iteration + step (+ live session while a step runs)
    ├── .looper-adjudicate         # written when PRD oscillation is detected; routes to the adjudicate step
    ├── .looper-adjudicate-session.json  # in-flight adjudicator session, reconciled on resume
    ├── .looper-prd-history.json   # per-story PRD passes transition log (+ adjudicated watermark); cleared only on --fresh
    └── .looper-story-state.json    # per-story phase (StoryPhase); cleared only on --fresh
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
validateResources: false             # optional: validate configured agents exist during startup
prd: spec/beta-1                     # optional PRD directory; relative paths resolve from the repo dir
context: true                        # optional; see "Prompt context" below
storyIdPattern: "^([a-z]+-[0-9]+)-"   # optional; overrides the default branch->story-id regex (see "Story gates" below)

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
    gate:                                        # optional; step is skipped (not run) unless every condition passes
      branch: story                              # "story" (a story id is derivable from the branch) | "main"
      prdPasses: true                             # requires top-level prd: configured
      phase: reviewed                             # requires the story's phase to be at or past this StoryPhase
      script: "test -f .ready"                    # bash -c script; must exit 0 (see "Story gates" below)
    setsPhase: reviewed                           # optional; on a `done` result, advances the story's phase (monotonic)
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
- `gate` &mdash; optional; see "Story gates" below.
- `setsPhase` &mdash; optional; see "Story gates" below.

Migration note: the former top-level `vcsSummary` option and Changes panel are retired in favor of the consolidated
Diff panel. Existing YAML containing `vcsSummary` still loads because unknown top-level keys are ignored, but the key
has no effect and should be removed.

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
context: false   # disable the block entirely for every step (shorthand for all eight keys false)

steps:
  build:
    ...
    context:                # per-step override; each key defaults to true (or to the top-level value)
      vcsDelta: false        # e.g. skip the (possibly large) file-change list for this one step
      prd: true
      sessionIds: true
```

Valid keys: `datetime`, `repoDir`, `loopPosition`, `timebox`, `vcsDelta`, `sessionIds`, `prd`, `story`. Each
accepts a boolean; an unknown key throws at load time naming the offending key. `context: false` (top level or
per-step) is shorthand for all eight keys `false`; `context: true` or an absent `context:` leaves every
key at its default (`true`). A per-step key wins over the top-level value for that same key, which wins
over the default.

`vcsDelta` is a file list + counts, not a full diff. It includes both committed branch delta vs the
resolved base branch and uncommitted working-tree changes, labels those groups separately, and caps at
50 files / about 3800 context characters; it is fetched fresh immediately before every prompt send and is
independent of the TUI `Diff` panel &mdash; turning one off does not affect the other. If the VCS
lookup errors or hangs past its bound, looper logs one line and sends the prompt without that section
rather than blocking or failing the step.

`prd` is included when top-level `prd:` is configured. It renders the configured artifact paths plus counts
when `prd.json` is readable:

```yaml
prd:
  dir: spec/beta-1
  index: spec/beta-1/prd.json
  progress: spec/beta-1/progress.txt
  passing: 12
  total: 41
  remaining: 29
```

In-repository paths are relative to the repo dir; paths outside the repo remain absolute. If `prd.json`
cannot be read, the path fields are still included and only the count fields are omitted. Disable the
entire block independently with `context.prd: false`.

`story` renders a `story:` block with whatever of `branch`, `storyId`, `passes`, `phase` looper could derive;
each field is omitted individually when unknown, and the whole block is omitted when no branch is derivable
(e.g. no git repo). Disable it with `context.story: false`.

### PRD progress

Set top-level `prd:` to the directory containing `prd.json` to enable PRD progress reporting. Relative paths
resolve against the repo dir, not the config dir:

```yaml
prd: spec/beta-1
```

When configured, the TUI shows a PRD progress panel and the prompt context can include the structured `prd:`
block above. Looper polls `prd.json` every few seconds and reports parse/read errors in the panel instead of
failing the run.

### Adjudication

If a user story's `passes` flag flips from `true` to `false` and back repeatedly (`prdFlipThreshold`
times, default 2), that's two steps enforcing contradictory readings of the PRD contract. Looper
detects this and routes to a dedicated adjudicate step with authority to amend the PRD contract itself,
instead of looping the same two steps forever.

Configure it with an optional top-level `adjudicate:` block, using the same fields as a `steps:` entry:

```yaml
adjudicate:
  agent: build
  prompt: adjudicate.md
```

`adjudicate:` is never part of the regular `steps:` sequence; it only runs when oscillation is detected
(or an agent writes `.looper-adjudicate` itself), as a one-off step inserted after the remaining steps in
that iteration are skipped. The adjudicator's prompt is prefixed with the detected oscillation trail. Only
a completed adjudication resolves the conflict: it clears the marker and advances a watermark so the
resolved flips no longer count toward detection (the full trail is retained for forensics). A failed
adjudicator keeps the marker and re-routes next iteration rather than being treated as resolved. If no
`adjudicate:` step is configured, looper stops the run instead and explains why in the stop file. Override
the flip threshold with `prdFlipThreshold:` or the `LOOPER_PRD_FLIP_THRESHOLD` environment variable.

### Story gates

A story id is derived from the current git branch (`storyIdPattern`, default `^([a-z]+-[0-9]+)-` matching
e.g. `us-074-fix-thing` &mdash; `US-074`), read fresh before every gate check, never cached.

A step's `gate:` skips that step (no opencode session is created) unless every configured condition passes:

- `branch: story` &mdash; a story id must be derivable from the current branch; `branch: main` &mdash; the current
  branch must literally be `main`.
- `prdPasses: true` &mdash; the story's `passes` flag in `prd.json` must be `true` (requires top-level `prd:`).
- `phase: <StoryPhase>` &mdash; the story's phase in `.looper-story-state.json` must be at or past the given phase
  in the order `building < implemented < reviewed < verified < published < merged`; a story with no recorded
  phase is treated as `building`.
- `script: "<bash>"` &mdash; the script is run via `bash -c` and must exit `0`. It gets the current branch and
  story id as `LOOPER_BRANCH`/`LOOPER_STORY_ID`, plus configured PRD paths as `LOOPER_PRD_DIR`,
  `LOOPER_PRD_INDEX`, and `LOOPER_PRD_PROGRESS`. Looper-owned variables are empty strings when unavailable;
  in-repository PRD paths are relative to the script's repo-dir working directory and external paths remain
  absolute. The script also inherits the process env. It is killed (its whole process group) if it runs past
  `LOOPER_GATE_SCRIPT_TIMEOUT_MS` (default 30000).

A skipped gate logs `[looper] gate skipped <step>: <reason>` and still advances the run to the next step, the
same as a normal completion.

`setsPhase: <StoryPhase>` advances that story's phase when the step finishes with a `done` result. The write is
skipped (and the phase auto-demoted to `building` instead) if the story's `passes` flag flipped `true` to
`false` during the step, and it never regresses an existing phase &mdash; only `looper signal story-phase` or the
auto-demote can move a phase backward.

### Signals

`looper signal <kind>` writes a state file directly, without needing a looper process running:

```bash
looper signal adjudicate --reason "manual escalation"
looper signal stop --reason "operator request"
looper signal stop-after-iteration --reason "let the current iteration finish"
looper signal story-phase reviewed                  # story id derived from the current branch
looper signal story-phase merged --story US-074      # explicit story id
```

It resolves `--config-dir` the same way a normal run does, exits `0` on success, and exits `2` with a usage
message on an unknown kind, a missing `--reason`, an invalid phase, or (for `story-phase` without `--story`)
a branch with no derivable story id.

### Branch diff

Whenever the current branch differs from the branch OpenCode detects as the repository's default, the TUI shows a
compact `Diff` panel above the PRD panel summarizing the branch's diff against that default branch: total `+additions`,
`-deletions`, and the number of changed files. Looper's polled branch snapshot is authoritative, while the data comes
live from OpenCode's own VCS API whenever its cached current branch agrees with that snapshot
(`client.vcs.get` for the current/default branch and `client.vcs.diff` in branch mode): the diff uses merge-base
semantics against the detected default branch and folds in committed, staged, unstaged, and untracked worktree changes,
so the totals match what OpenCode reports. Only while OpenCode's cached branch lags Looper's watcher does the panel use a
narrow read-only Git fallback with the same merge-base-to-working-tree scope. A feature branch with no changes shows
`+0 -0 0 files`. The panel is absent
from the layout while checked out on the default branch itself, and refreshes at startup, on branch switches, and at
each step's begin and finish. There is nothing to configure &mdash; the default branch is whatever OpenCode detects.

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
- `LOOPER_BRANCH_DIFF_TIMEOUT_MS` &mdash; timeout for one live Diff-panel collection (default: `10000`)
- `LOOPER_GATE_SCRIPT_TIMEOUT_MS` &mdash; timeout for a step's `gate.script` (default: `30000`)
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
