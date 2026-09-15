# Looper

A small TUI tool that drives OpenCode through a sequence of agent steps, on a loop, until every PRD story reaches its terminal phase, a step signals stop, or the iteration cap hits.

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
looper --fresh --start                  # start immediately, ignoring any saved checkpoint (story phases are kept)
looper --fresh --reset-stories          # fresh run that also wipes .looper-story-state.json
looper --attach=http://127.0.0.1:4096   # connect to an existing OpenCode server
looper --config-dir=.local/looper       # use a specific config/state directory
looper --wait=10                        # pause 10 minutes between iterations
looper --wait                           # pause for the previous iteration's runtime
looper 5                                # cap at 5 iterations (positional; default 100)
looper --help
```

Press `?` in the TUI for a keybinding overlay.

CLI flags:

- `init` &mdash; scaffold the config directory (`looper.yml`, `work.md`) and exit. Refuses to overwrite an existing config.
- `signal <kind>` &mdash; write a state file directly, without a looper process running. This is how steps report story outcomes. See "Signals" below.
- `--attach[=url]` &mdash; connect to an existing opencode server instead of spawning one. Without a URL: tries `opencode.serverUrl` from the config file, then `$OPENCODE_ATTACH_URL`, then `http://127.0.0.1:4096`.
- `--config-dir=path` / `--config-dir path` &mdash; use this directory for config, prompts, and state files. Overrides auto-detection and `$LOOPER_CONFIG_DIR`.
- `--start` &mdash; skip the TUI start prompt and begin immediately.
- `--fresh` &mdash; ignore any saved checkpoint, clear Looper's permission audit, signals log, and phase history, and start a new run from iteration 1, step 1. Story phases in `.looper-story-state.json` survive, so already-merged stories are not picked up again. It does not revoke OpenCode project-level `always` permissions.
- `--reset-stories` &mdash; also clear `.looper-story-state.json`. Only valid together with `--fresh`.
- `--continue` &mdash; deprecated alias of `--start` (resuming is now the default).
- `--wait[=minutes]` &mdash; sleep between iterations. With `=N`, sleep N minutes. Without a value, sleep for the previous iteration's wall-clock duration.
- `max_iterations` (positional, default `100`) &mdash; stop after this many iterations if the run has not already stopped (PRD complete, stop signal, stall).

Without `--config-dir`, looper looks under `$PWD` in this order: `.looper`, `.local/looper`, `.local/.looper`. The first directory that already contains a config file wins; if none do, looper defaults to `.looper`. Within that directory, config file resolution prefers `looper.yml`, then `looper.yaml`, `.looper.yml`, `.looper.yaml`.

Both terminal UIs show the selected agent’s current activity inside the output pane’s bottom border. Its moving
color gradient stays visible while scrolling; `LOOPER_REDUCED_MOTION=1` keeps it static.

## Resuming

Looper resumes the previous run by default. If you quit (or it stops) mid-run, the next start picks up at the
same iteration and step. While a step is running, looper records its opencode session in `.looper-run.json`; on
resume it reattaches to that session if it is still generating, otherwise it restarts the step in a fresh session.
Both terminal UIs check the saved session during startup, including delegated work when its parent is idle.
If work is still running and the checkpoint identifies its turn, Looper automatically reattaches and resumes
the loop, clearing prior stop markers. No step selection or reattach action is needed. Unknown or stale status
and incomplete checkpoints remain in recovery handling. Inspecting or reselecting the saved step preserves
its session and message IDs. An unavailable status is never treated as idle.

Manual recovery nudge is the exception: when the failed session is known and already idle, nudge sends a short
continue-working message to that existing session without replaying the original prompt. The current step row,
output, and elapsed time are preserved; if the session cannot be reused, looper falls back to a fresh restart.
A run that reaches `max_iterations` clears its checkpoint, so the next start begins a new run. Pass `--fresh` to
ignore the checkpoint and start over from iteration 1. If the saved step index no longer matches the configured
step at that position (you removed or reordered steps), looper logs it, confirms the checkpoint session is
stopped so it cannot keep generating, and continues at the next iteration, step 1. If that stop cannot be
confirmed, the run halts instead of starting overlapping work.

Completed step agents remain visible across iterations and return when Looper is reopened. Their statuses,
session metadata, and child agents are saved in `.looper-agents.json` under the config directory. Only
`--fresh` or the TUI fresh reset clears this trail; reaching the iteration limit preserves it.

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
    ├── .looper-stop         # written when the run stops (PRD complete, stop signal, stall, exhausted retries)
    ├── .looper-stop-after-iteration
    ├── .looper-resume-step.json   # legacy step-only checkpoint
    ├── .looper-run.json           # resume pointer: iteration + step (+ live session while a step runs)
    ├── .looper-adjudicate         # written when phase-demotion oscillation is detected; routes to the adjudicate step
    ├── .looper-adjudicate-session.json  # in-flight adjudicator session, reconciled on resume
    ├── .looper-phase-history.json # per-story phase transition log (+ adjudicated watermark); cleared only on --fresh
    ├── .looper-signals.jsonl      # append-only log of every `looper signal`; cleared only on --fresh
    ├── .looper-permission-log.jsonl # private decision audit (0600); cleared only on --fresh
    ├── .looper-story-state.json    # per-story phase (StoryPhase); cleared only on --fresh --reset-stories
    └── .looper-state-lock.sqlite   # machine-local mutex; gitignored, recreates on next write
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
terminalPhase: merged                # optional; the run stops once every story reaches this phase (default merged)
mainBranch: main                     # optional; branch that derived published/merged phases are checked against (default main)
context: true                        # optional; see "Prompt context" below
storyIdPattern: "^([a-z]+-[0-9]+[a-z]?)-"   # optional; overrides the default branch->story-id regex (see "Story gates" below)

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
      phase: implemented                          # story's effective phase must be at or past this (requires prd:)
      phaseBelow: reviewed                        # skip when the story is already at or past this phase (requires prd:)
      script: "test -f .ready"                    # bash -c script; must exit 0 (see "Story gates" below)
    expects: reviewed                             # optional; the step must end with an outcome signal (see "Outcome contract")
    setsPhase: reviewed                           # optional; on a `done` result, advances the story's phase (monotonic; never later than expects)
  push:
    name: Push
    prompt: push.md
    gate:
      branch: story
      phase: verified
      phaseBelow: published
    expects: published
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

### Permission UX

When a permission or question is left pending (policy `ask`, or no policy), the TUI opens a "waiting on you" gate. For permissions press `y` to allow once, `a` to allow always, `d` to deny, or `s` to deny and skip the step. For questions, `d` rejects and `s` rejects and skips; answer free-text or multi-option questions in an attached OpenCode client. `q` still quits while the gate is open.

`always` changes OpenCode's project permission state outside Looper's config directory. Looper never learns an `always` rule from prior answers, and `--fresh` does not revoke one. In non-TTY/unattended mode, Looper never sends `always`: `ask` is rejected immediately, configured `once`/`reject` is honored, and configured `always` fails closed by rejecting with an error line. Three successful automated rejects of the same permission kind in one logical step write the stop diagnosis `permission friction: automated reject limit for '<kind>'`.

Each Looper-issued decision is appended to `.looper-permission-log.jsonl` in the config directory with mode `0600`. The JSONL contains timestamp, request/session IDs, request kind, optional permission kind, action, origin, and optional step index; request patterns are omitted. Audit write failures do not fail the step, the audit is never used for auto-reply, and all three `--fresh` paths clear it.

The TTY rings once for newly gated requests by default. Set `LOOPER_PERMISSION_BELL=0` to silence it. Human asks have a finite `LOOPER_PERMISSION_GATE_MAX_MS` deadline (default 30 minutes), and request cleanup is bounded by `LOOPER_PERMISSION_TEARDOWN_MS` (default 5 seconds).

- `title` &mdash; see "Session titles" below.
- `context` &mdash; see "Prompt context" below.
- `gate` &mdash; optional; see "Story gates" below.
- `expects` &mdash; optional; see "Outcome contract" below.
- `setsPhase` &mdash; optional; see "Story gates" below.

Migration note: the former top-level `vcsSummary` option and Changes panel are retired in favor of the consolidated
Diff panel. Existing YAML containing `vcsSummary` still loads because unknown top-level keys are ignored, but the key
has no effect and should be removed.

### Prompt context

Every prompt that opens a new session (fresh step, restart, retry) is
prefixed with a small `<looper-context>` block giving the agent situational facts it would otherwise
have to rediscover: current datetime, repo dir, loop position, this step's timebox, an uncached VCS
delta, optional PRD progress, and the opencode session IDs of this iteration's already-finished steps (heading `Opencode
sessions from earlier steps this iteration:`). The block is read-only context, never instructions, and
never contains anything from a past iteration. Follow-up turns on an already-running session (recovery
nudge, background continuation, orphaned-background nudge) are sent without that block — the original
prompt is already in the session history.

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

`prd` is included when top-level `prd:` is configured. It renders the configured artifact paths plus phase
counts when `prd.json` is readable. `complete` counts stories at or past `terminalPhase`; `phases` lists the
remaining stories with their effective phase (capped at 12, then `+K more`):

```yaml
prd:
  dir: spec/beta-1
  index: spec/beta-1/prd.json
  progress: spec/beta-1/progress.txt
  complete: 12
  total: 41
  remaining: 29
  terminal: merged
  phases: US-013=reviewed, US-014=building, ...
```

In-repository paths are relative to the repo dir; paths outside the repo remain absolute. If `prd.json`
cannot be read, the path fields are still included and only the count fields are omitted. Disable the
entire block independently with `context.prd: false`.

`story` renders a `story:` block with whatever of `branch`, `storyId`, `phase` (effective), and the branch
naming rule looper could derive, plus `next: <id> — <title>`, the story the engine selected for this iteration
(see "Story selection"). `next` is present even when the current branch is not a story branch, so a build step
knows what to pick up. Steps with `expects:` also get `expects: <phase>` and one `outcome:` line spelling out
the four signals that can end the step. Each field is omitted individually when unknown, and the whole block is
omitted when nothing in it is derivable (e.g. no git repo and no PRD). Disable it with `context.story: false`.

### PRD progress

Set top-level `prd:` to the directory containing `prd.json` to enable PRD progress reporting. Relative paths
resolve against the repo dir, not the config dir:

```yaml
prd: spec/beta-1
```

When configured, the TUI shows a PRD progress panel and the prompt context can include the structured `prd:`
block above. Looper polls `prd.json` every few seconds and reports parse/read errors in the panel instead of
failing the run.

`prd.json` is a spec, nothing more. Looper reads `userStories[].{id,title,priority,dependsOn}` and ignores any
`passes` flag; it never writes the file. Where a story actually stands lives in the phase ladder described next.

### Story phases

Every story moves along one ladder: `building < implemented < reviewed < verified < published < merged`. Phases
are stored per story in `.looper-story-state.json`; a story with no entry is `building`. Two phases are also
derived from git, so a story cannot be stuck below what the repository proves:

- `published` &mdash; a branch whose name resolves to the story exists under `refs/remotes/origin/`.
- `merged` &mdash; such a branch tip is an ancestor of `origin/<mainBranch>`.

The **effective phase** is the higher of stored and derived. When git says more than the ledger, looper persists the
upgrade (so deleting a branch after merge does not lose `merged`) and logs
`[looper] story US-xxx: phase merged (derived from git)`. Gates, prompt context, story selection, stall detection,
run termination, and `expects` all read the effective phase. Git failures never throw; they just yield no derived
phase. Looper runs a best-effort `git fetch origin <mainBranch>` once per iteration boundary
(`LOOPER_STORY_FETCH_TIMEOUT_MS`, default 15000, `0` disables).

`terminalPhase:` (default `merged`) is the phase at which a story counts as complete. `mainBranch:` (default
`main`) is the branch derived phases are checked against.

### Story selection

Each iteration the engine picks a `next` story and exposes it in the prompt context:

1. If the current branch resolves to a PRD story that is still below the terminal phase, that story wins (in-flight
   work is never abandoned).
2. Otherwise the first story by `priority` (ascending; missing priority sorts last; ties keep file order) that is
   below terminal and whose `dependsOn` entries that exist in this PRD are all at or past terminal. Unknown
   dependency ids are treated as satisfied.
3. If every remaining story has an unmet dependency, looper picks the first non-terminal story anyway and logs a
   warning naming the unmet dependencies. A bad `dependsOn` graph slows nothing down.
4. Nothing left: no `next`.

### Run termination

There is no "check done" step. At the start and end of every iteration, after the fetch, looper takes a fresh
phase snapshot; when `prd:` is configured, `prd.json` is readable, it has at least one story, and every story's
effective phase is at or past `terminalPhase`, looper writes `.looper-stop` with
`PRD complete: N/N stories at phase <terminal>` and the run ends. An unreadable PRD or one with zero stories never
stops the run (looper logs why, once per iteration). Checking at iteration start means a resumed or stale run stops
immediately instead of running one more lap.

### Adjudication

If a story keeps getting demoted (a `looper signal story-phase` that moves it to a lower phase, `prdFlipThreshold`
times, default 2), that's two steps enforcing contradictory readings of the PRD contract: one keeps promoting,
the other keeps handing back. Looper detects this and routes to a dedicated adjudicate step with authority to
amend the PRD contract itself, instead of looping the same two steps forever. Only signal-sourced demotions
count; the engine's own phase reset on new commits (see "Outcome contract") never does.

Configure it with an optional top-level `adjudicate:` block, using the same fields as a `steps:` entry:

```yaml
adjudicate:
  agent: build
  prompt: adjudicate.md
```

`adjudicate:` is never part of the regular `steps:` sequence; it only runs when oscillation is detected
(or an agent writes `.looper-adjudicate` itself), as a one-off step inserted after the remaining steps in
that iteration are skipped. The adjudicator's prompt is prefixed with the detected oscillation trail. Only
a completed adjudication resolves the conflict: it clears the marker and advances a watermark in
`.looper-phase-history.json` so the resolved demotions no longer count toward detection (the full trail is
retained for forensics). A failed adjudicator keeps the marker and re-routes next iteration rather than being
treated as resolved. If no `adjudicate:` step is configured, looper stops the run instead and explains why in
the stop file. Override the demotion threshold with `prdFlipThreshold:` or the `LOOPER_PRD_FLIP_THRESHOLD`
environment variable (the name is historical; it counts demotions).

### Story gates

Story IDs are resolved from a fresh git branch read before every gate check. With a configured PRD,
Looper first matches the longest exact story ID followed by `-` at the start of the branch, ignoring
case and preserving the ID's spelling in `prd.json`. For example, `us-609e0-recipe-init-integration`
resolves to `US-609E0` when that ID exists in the PRD. The PRD is read fresh, so split stories added
during Build are recognized by later steps without changing configuration or restarting Looper.

If no PRD ID matches, `storyIdPattern` remains the fallback (default `^([a-z]+-[0-9]+[a-z]?)-`,
capture group 1 uppercased). Custom patterns still support other branch layouts. The naming rule is
included in story prompt context before agents create branches.

When a step switches to an unrecognized feature branch, Looper requests one repair in the same session,
within the remaining step time budget. The request preserves the full story ID and directs the agent
to rename the branch without editing Looper configuration or stopping the run. Looper verifies the
result with a fresh git read; a failed or unresolved repair fails the current step and leaves its
checkpoint in place instead of advancing into skipped story gates. Mainline branches remain exempt.

A step's `gate:` skips that step (no opencode session is created) unless every configured condition passes:

- `branch: story` &mdash; a story id must be derivable from the current branch; `branch: main` &mdash; the current
  branch must literally be `main`.
- `phase: <StoryPhase>` &mdash; the story's effective phase must be at or past the given phase (requires top-level
  `prd:`). A story with no recorded phase is `building`.
- `phaseBelow: <StoryPhase>` &mdash; skip when the story's effective phase is already at or past the given phase
  (requires `prd:`). The reason reads `gate: phase <p> is at or past <phaseBelow> (nothing to do)`. Together,
  `phase` and `phaseBelow` bracket the window in which a step has work: `{phase: implemented, phaseBelow: reviewed}`
  runs Review exactly once per implementation.
- The story a phase condition evaluates is the branch story if the current branch resolves to a PRD story, else the
  engine's selected `next` story. With neither, the phase conditions pass (fail open) so a build step can run on
  `main` and create the branch.
- `prdPasses: true` is accepted as a deprecated alias of `phase: implemented` and logs a warning at load time.
- `script: "<bash>"` &mdash; the script is run via `bash -c` and must exit `0`. It gets the current branch and
  story id as `LOOPER_BRANCH`/`LOOPER_STORY_ID`, plus configured PRD paths as `LOOPER_PRD_DIR`,
  `LOOPER_PRD_INDEX`, and `LOOPER_PRD_PROGRESS`. Looper-owned variables are empty strings when unavailable;
  in-repository PRD paths are relative to the script's repo-dir working directory and external paths remain
  absolute. The script also inherits the process env. It is killed (its whole process group) if it runs past
  `LOOPER_GATE_SCRIPT_TIMEOUT_MS` (default 30000).

A skipped gate logs `[looper] gate skipped <step>: <reason>` (the reason includes what was observed and what was
expected) and still advances the run to the next step, the same as a normal completion. When `prd:` is configured,
the same line is appended to `prd.progress` so later steps can see why a gate did not run.

If a running step switches off the default branch onto a name that is not a story branch, looper logs that immediately
and, after the current turn ends, sends a same-session continue-working follow-up that includes the story-id pattern
so the agent can rename before later gated steps skip.

`setsPhase: <StoryPhase>` advances that story's phase when the step finishes with a `done` result. It never
regresses an existing phase; only `looper signal story-phase` or the engine's commit reset can move a phase
backward. On a step that also has `expects:`, `setsPhase` may not be later than `expects` (load-time error),
and the write is skipped when the outcome contract was not satisfied or the reset fired. Prefer signals from the
prompt over `setsPhase`: a signal is a claim the agent makes after checking its own work, and it is subject to
the preconditions below.

### Outcome contract

A step that only has to "finish its turn" is easy to gut: a rejected permission prompt or an early exit still reads
as `done`. Give the step `expects: <StoryPhase>` and it must instead end with a signal that says what happened
to the story. The story evaluated is the branch story after the step ends (re-read from git, since Build creates
the branch during its turn), else the selected `next` story. After the turn completes, in this order:

1. **Commit reset.** Looper recorded `HEAD` at step start. If new commits landed, the story's stored phase is at
   or past `expects`, and no `story-phase` signal for that story arrived during the step, the stored phase is
   reset to the phase just below `expects` and logged as `phase reset to <p> (new commits during <step>)`. The
   story was reworked, so the step has to re-prove the phase. An explicit signal during the step is the agent's
   own re-proof and is never overridden; derived phases are unaffected.
2. **Decision.** Effective phase at or past `expects`: `done`. Otherwise the signals since step start for that
   story decide: `blocked` ends the step as blocked; `no-op` and `adjudicate` end it as `done` (reason logged);
   a `story-phase` to a phase lower than where the story started (a hand-back) ends it as `done`.
3. **No signal.** If a permission prompt timed out during the step, or less than
   `LOOPER_OUTCOME_REMINDER_MIN_MS` (default 60000) remains in the step budget, the step is blocked with that
   reason and no reminder is sent. Otherwise looper sends one same-session reminder listing the four acceptable
   signals and asking the agent to signal and stop, then re-evaluates. A second silent turn fails the step with
   `step ended without an outcome signal`, with no automatic retry; the next iteration runs the step again because
   the phase did not advance.

A **blocked** step is not a failure. Its row shows `blocked: <reason>`, the resume pointer advances like a
completion, later steps in the iteration see `<step>=blocked (<reason>)` in their prior-steps context, and when
`prd:` is configured the line `[looper] <step> blocked: <reason>` is appended to `prd.progress`. Gates keep the
downstream steps closed until the phase actually moves.

### Signals

`looper signal <kind>` writes a state file directly, without needing a looper process running:

```bash
looper signal adjudicate --reason "manual escalation"
looper signal stop --reason "operator request"
looper signal stop-after-iteration --reason "let the current iteration finish"
looper signal story-phase reviewed                          # story id derived from the current branch
looper signal story-phase merged --story US-074              # explicit story id
looper signal story-phase building --reason "tests fail"     # hand a story back, with the defect
looper signal blocked --reason "CI runner is down"           # this step could not do its job
looper signal no-op --reason "PR already merged"             # nothing to do this time
```

It resolves `--config-dir` the same way a normal run does, exits `0` on success, and exits `2` with a usage
message on an unknown kind, a missing `--reason` (required for everything except `story-phase`, where it is
optional but recorded), an invalid phase, or a story-scoped signal without `--story` on a branch with no derivable
story id. `blocked` and `no-op` may be storyless; `story-phase` may not. Every signal is also appended to
`.looper-signals.jsonl`, which is how a step with `expects:` learns what the agent decided.

`story-phase` is a claim, and looper checks the ones it can before accepting it:

- `implemented` &mdash; at least one commit on `HEAD` that is not on `origin/<mainBranch>` touches a path outside the
  PRD directory. Docs-only churn does not count. If `origin/<mainBranch>` cannot be resolved, the claim is accepted.
- `published` &mdash; a branch for the story exists under `refs/remotes/origin/`; otherwise "push the branch first".
- `merged` &mdash; after a best-effort fetch, a story branch tip must be an ancestor of `origin/<mainBranch>`. If no
  branch for the story exists locally or remotely, the claim is accepted (it cannot be disproved).
- `building`, `reviewed`, `verified` &mdash; no precondition.
- No `story-phase` may set a phase below the story's git-derived phase: a merged story cannot be demoted.

A rejected claim exits `2` with the reason, so the agent sees why and can fix the underlying state instead of
the ledger.

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

A step ends the loop with `looper signal stop --reason "..."` (which writes `.looper-stop` in the config directory); the engine also stops on PRD completion and on a detected stall.

## Develop

```bash
bun install
bun run typecheck
bun run test:unit        # parallel unit suite (excludes e2e)
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
- `LOOPER_STORY_FETCH_TIMEOUT_MS` &mdash; timeout for the per-iteration `git fetch origin <mainBranch>` behind derived phases (default: `15000`; `0` disables the fetch)
- `LOOPER_OUTCOME_REMINDER_MIN_MS` &mdash; minimum remaining step budget for an `expects:` reminder turn; below it the step is blocked instead (default: `60000`)
- `LOOPER_PRD_FLIP_THRESHOLD` &mdash; signal-sourced demotions of one story before adjudication routes (default: `2`)
- `LOOPER_PERMISSION_GATE_MAX_MS` &mdash; maximum attended wait for each permission/question ask (default: `1800000`; must be at least `1`)
- `LOOPER_PERMISSION_TEARDOWN_MS` &mdash; total deadline for stopping a session and resolving its open requests (default: `5000`)
- `LOOPER_PERMISSION_BELL` &mdash; TTY alert for newly gated permission/question requests (`1` by default; set `0` to disable)
- `LOOPER_CONTINUATION_EXIT_GRACE_MS` &mdash; how long to wait after a step exits for a background-continuation record to appear (default: 30000)
- `LOOPER_EVENT_WATCHDOG_POLL_MS` &mdash; event-stream watchdog poll interval (default: `15000`)
- `LOOPER_EVENT_STALL_MS` &mdash; event-stream idle threshold before probing session status (default: `45000`)
- `LOOPER_EVENT_RESUBSCRIBE_BACKOFF_MS` &mdash; minimum delay between event-stream reconnect attempts (default: `1000`)
- `LOOPER_EMPTY_ASSISTANT_GRACE_MS` &mdash; grace window for opencode to revive a session that ended without assistant output, before looper fails the step (default: `10000`; `0` disables)
- `LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS` &mdash; poll interval during that grace window (default: `500`)
- `LOOPER_STOP_SESSION_POLL_MS` &mdash; poll interval while confirming a prior session stopped (default: `250`)
- `LOOPER_STOP_SESSION_TIMEOUT_MS` &mdash; timeout while confirming a prior session stopped (default: `10000`)
- `LOOPER_SERVER_RECOVERY_MAX_WAIT_MS` &mdash; maximum wait while recovering a server/session status probe (default: `600000`)
- `LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS` &mdash; initial server recovery backoff (default: `2000`)
- `LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS` &mdash; maximum server recovery backoff (default: `30000`)
- `LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS` &mdash; per-probe server recovery timeout (default: `10000`)
- `LOOPER_PROMPT_VCS_TIMEOUT_MS` &mdash; timeout for prompt-context VCS lookup (default: `5000`)
- `LOOPER_INHERITED_TITLE_DELAY_MS` &mdash; delay before applying an inherited title to later-step sessions (default: `5000`)
- `LOOPER_TITLE_GEN_TIMEOUT_MS` &mdash; timeout for title generation sessions (default: `60000`)
- `LOOPER_FAILURE_RETRY_BASE_MS` &mdash; first automatic failure-retry delay (default: `15000`; doubles each attempt)
- `LOOPER_FAILURE_RETRY_MAX_DELAY_MS` &mdash; cap on that delay (default: `300000`)
- `LOOPER_FAILURE_RETRY_MIN_REMAINING_MS` &mdash; stop retrying when remaining step timeout is at or below this (default: `5000`)
- `LOOPER_FAILURE_RETRY_JITTER` &mdash; delay jitter ratio 0–1 (default: `0.2`; `0` disables)

## Experimental agent UI

Run `LOOPER_UI=constellation looper` for agent bubbles with gentle pulses, flowing gradients, and simultaneous activity summaries. Double-click a bubble or press Enter to inspect its full output, model, variant, prompt, and project context. Preview without a server with `bun run demo:constellation`. See [the Constellation guide](docs/constellation.md) for controls and behavior.


While the TUI is active, runtime warnings and errors appear in **Diagnostics** instead of printing over the screen. Press **l** or click the footer indicator to read them; **Esc** closes the window.
