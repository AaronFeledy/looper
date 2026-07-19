# Target architecture

This is the migration target for Looper. Read it before adding features or
moving code.

Current code still lives partly in `src/lib/*` and `src/tui/*`. Compatibility
shims are expected while the migration is in progress.

## Design stance

Use ports at the expensive seams:

1. OpenCode
2. persistence
3. presentation
4. title generation
5. watchers

Everything else stays plain functions. An interface exists only when there are
two real consumers or a side effect worth isolating.

Runtime dependencies stay frozen unless this document is changed first:

1. `@opentui/core`
2. `@opencode-ai/sdk`
3. `yaml`

## Target directory layout

1. `src/main.ts`
   Thin entry only.

2. `src/cli/`
   Args, bootstrap, and runtime lifecycle. Bootstrap resolves `configDir`,
   starts or attaches the server, constructs services, and selects TTY or
   non-TTY presentation.

3. `src/config/`
   `looper.yaml` loading, step schema, `tunables.ts`, and config types.
   `tunables.ts` owns all `LOOPER_*` environment parsing and timeout defaults.

4. `src/core/`
   Pure logic: step-machine, resume-policy, retry-policy, prompt-builders,
   prompt-context, `events.ts`, run-types, and `backoff.ts`. `events.ts`
   defines the structured `LooperEvent` union. No SDK, no OpenTUI, no fs, no
   `process.env`.

5. `src/engine/`
   Run orchestration independent of UI and SDK details. Contains
   `run-engine.ts`, `run-iteration.ts`, `title-coordinator.ts`, and
   `engine-ports.ts`. `run-iteration.ts` is the relocated orchestrator core.
   `run-engine.ts` is one engine shared by TTY and non-TTY:
   resume plan, run-state advancement, stop handling, `runIteration`
   invocation, and session binding. `engine-ports.ts` defines engine-facing
   ports including `RunStateStore` and `TitleService`.

6. `src/opencode/`
   OpenCode integration: gateway SDK wrapper, step-runner, reattach,
   event-stream with watchdog, resubscribe, and backfill, event-consumer from
   SDK event to `LooperEvent`, continuation-records, background-tasks,
   session-health, session-metadata, managed-resources, title-agent, and
   opencode-id.

7. `src/persistence/`
   State files and stop files. `run-state-store.ts` is the sole writer of
   `.looper-run.json` and `.looper-resume-step.json`. This directory also owns
   state-paths and stop-files.

8. `src/presentation/`
   Output frontends. `text-printer.ts` maps `LooperEvent` to plain text.
   `legacy-line-format.ts` preserves golden-test compatibility. `tui/` owns
   app, state, components, and `stream-blocks.ts`. `fallback/` owns the
   non-TTY frontend.

9. `src/watchers/`
   Watchers and typed watcher events: branch, branch-delta, GitHub, PRD, and
   watcher-events.

10. `src/platform/`
    Host integration helpers: git helpers, opencode-server spawn and attach,
    and `acquire-release.ts`.

## Dependency rules

1. `core/` imports only `core/` and simple config types. No SDK, no OpenTUI,
   no filesystem, no `process.env`.
2. `engine/` imports `core/` plus port interfaces from `engine-ports.ts`. It
   must not import `@opentui/core` or concrete persistence. Type-only
   `@opencode-ai/sdk` imports are permitted. `engine/run-iteration.ts`
   transitionally retains direct SDK/fs usage as the relocated orchestrator core
   until the OpencodeGateway port lands; new engine code must use ports from
   `engine-ports.ts`.
3. `opencode/` implements OpenCode-facing ports; may import the SDK.
4. `persistence/` is the only layer reading and writing `.looper-run.json`,
   `.looper-resume-step.json`, and stop files. Only the engine calls it during
   execution.
5. `presentation/tui/` owns mutable UI state; engine, opencode, and watchers
   never mutate TUI state directly.
6. `presentation/fallback/` and `presentation/tui/` are two frontends over the
   same `RunEngine`.
7. `watchers/` emit typed events; they never import TUI state.
8. `main.ts` imports only `cli/bootstrap`.

## Backward-compatible external contracts

These contracts remain backward compatible during the migration. Existing
fields retain their meanings, while new optional fields may be added when old
readers can safely ignore them and new readers accept files where they are
absent. Move code behind these contracts without requiring a schema migration.

### `.looper-run.json`

Authoritative run pointer under `configDir`:

```ts
{
  iteration: number
  stepIndex: number
  stepName: string
  sessionID?: string
  messageID?: string
  promptText?: string
  looperMessageIDs?: string[]
  title?: string
  looperRunID?: string
  stepSessions?: { stepIndex: number; stepName: string; sessionID: string }[]
}
```

`sessionID`, `messageID`, `promptText`, and `looperMessageIDs` exist only while
a step is in flight. `messageID` selects the user turn whose assistant result
classifies the step outcome. Independently, `looperMessageIDs` is the complete
ownership set used to hide only Looper-authored user turns from rendered
output. `promptText` preserves the exact Looper prompt exposed by the prompt
dialog; it is not reconstructed during recovery. Follow-up Looper turns append
their IDs to the copied ownership set.

Files written before `promptText` and `looperMessageIDs` were introduced remain
valid. When those fields are absent, recovery uses `messageID` as the sole known
Looper-owned user-message ID and does not invent a prompt. `title` and
`stepSessions` carry within an iteration and are dropped at the iteration
boundary. Resuming remains the default. `--fresh` clears this file.

### `.looper-resume-step.json`

Legacy step-only checkpoint under `configDir`. It remains in sync with the run
state for backward compatibility. `--fresh` clears this file too.

### `.omo/run-continuation/*.json`

This is an OpenCode plugin contract. The path, record shape, and timing stay
compatible. `LOOPER_CONTINUATION_EXIT_GRACE_MS` still controls the grace window
after a step exits.

### Session metadata

Looper-owned OpenCode sessions keep this shape:

```ts
{
  looper: true
  looperRunID: string
  iteration: number
  stepIndex: number
  stepName: string
  configDir: string
  repoDir: string
  purpose: "step" | "title"
  parentID?: string
  parentSessionID?: string
}
```

Step sessions use `purpose: "step"`. Title sessions use `purpose: "title"` and
may include `parentID` or `parentSessionID`.

### Managed OpenCode resources

The hidden `looper-title` agent remains in the global OpenCode agent dir:

1. `$XDG_CONFIG_HOME/opencode/agent`
2. `~/.config/opencode/agent`

The managed-resource marker comment is frozen. Looper overwrites only a file
carrying that marker. It never overwrites a user-authored `looper-title.md`.

### `LOOPER_*` environment variables

All names and defaults stay frozen:

1. `LOOPER_CONFIG_DIR`, default: config-dir auto-detection, then `$PWD/.looper`
2. `LOOPER_REPO_DIR`, default: `$PWD`
3. `LOOPER_DEBUG_EVENTS`, default: off
4. `LOOPER_CONTINUATION_EXIT_GRACE_MS`, default: `30000`
5. `LOOPER_EVENT_WATCHDOG_POLL_MS`, default: `15000`
6. `LOOPER_EVENT_STALL_MS`, default: `45000`
7. `LOOPER_EVENT_RESUBSCRIBE_BACKOFF_MS`, default: `1000`
8. `LOOPER_TITLE_GEN_TIMEOUT_MS`, default: `60000`
9. `LOOPER_E2E_KEEP`, test-only, default: off
10. `LOOPER_E2E_MODEL`, test-only, default: the e2e test model

Related non-`LOOPER_*` names also stay frozen:

1. `OPENCODE_BIN`, default: `opencode`
2. `OPENCODE_ATTACH_URL`, default: attach fallback URL

### CLI flags

The CLI surface stays frozen:

1. `--attach[=url]`
2. `--start`
3. `--fresh`
4. `--continue`, deprecated alias of `--start`
5. `--wait[=minutes]`
6. positional `max_iterations`, default `100`
7. `--help`

Attach URL resolution remains: CLI value, `opencode.serverUrl`,
`OPENCODE_ATTACH_URL`, then `http://127.0.0.1:4096`.

### `looper.yaml` schema

The schema stays frozen:

Intentional consolidation exception: the former top-level `vcsSummary` option and Changes panel are retired in favor
of the Diff panel. The loader continues to ignore this unknown top-level key so shipped YAML remains loadable, but it
has no effect and users should remove it. Do not restore the option or panel.

1. `opencode.serverUrl`
2. `opencode.title.agent`
3. `opencode.title.model`
4. `opencode.title.variant`
5. top-level `attachUrl`, alias for `opencode.serverUrl`
6. `recovery.snapshots`
7. top-level `timeout`
8. top-level `permissionPolicy`
9. top-level `questionPolicy`
10. top-level `useSessionIdle`
11. top-level `validateResources`
12. top-level `prd`
13. top-level `context`
14. `steps`

Per-step fields stay: `name`, `agent`, `model`, `variant`, `prompt`, `prefix`,
`suffix`, `args`, `timeout`, `permissionPolicy`, `questionPolicy`, `title`, and
`context`.

Prompt context keys stay: `datetime`, `repoDir`, `loopPosition`, `timebox`,
`vcsDelta`, `sessionIds`, and `prd`.

Config file discovery remains ordered:

1. `looper.yml`
2. `looper.yaml`
3. `.looper.yml`
4. `.looper.yaml`

Prompt paths still resolve relative to `configDir` unless absolute.

## Migration status

<table>
  <thead><tr><th>Phase</th><th>Scope</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>0</td><td>hygiene</td><td>DONE</td></tr>
    <tr><td>1</td><td>tunables+cycle break</td><td>DONE</td></tr>
    <tr><td>2</td><td>run-state store</td><td>DONE</td></tr>
    <tr><td>3</td><td>runner split</td><td>DONE</td></tr>
    <tr><td>4</td><td>orchestrator split</td><td>DONE</td></tr>
    <tr><td>5</td><td>structured events+golden formatter</td><td>DONE</td></tr>
    <tr><td>6</td><td>TUI structured rendering</td><td>DONE</td></tr>
    <tr><td>7</td><td>shared RunEngine</td><td>DONE</td></tr>
    <tr><td>8</td><td>watchers extraction</td><td>DONE</td></tr>
  </tbody>
</table>

Remaining future work: OpencodeGateway port extraction (`engine/run-iteration.ts`
and step execution still use `OpencodeClient` directly).
