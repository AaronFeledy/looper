# AGENTS.md

This file is for non-obvious repo context only. Keep it short and current.

## Stack

- Bun + TypeScript, no bundler. `tsc -b` typecheck only, `noEmit: true`.
- Runtime deps: `@opentui/core`, `@opencode-ai/sdk`, `yaml`. No other production deps; do not add them lightly.

## Commands

- `bun install`
- `bun run typecheck`
- `bun test` &mdash; includes a real-network e2e against opencode + gpt-5.5; self-skips when `opencode` is not on `PATH`. ~50 seconds, ~zero cost.

## Architecture

- `src/main.ts` &mdash; CLI entry. Decides TTY vs non-TTY mode, owns the renderer, spawns/attaches the opencode server.
- `src/lib/orchestrator.ts` &mdash; runs one iteration: loop over steps, handle restart / skip / failure retries / background-task waits.
- `src/lib/runner.ts` &mdash; runs one step against opencode (session create, prompt, subscribe to events, abort on cancel). Reads `.omo/run-continuation/*.json` from the project repo to detect background tasks. Also exports `reattachOpenCodeStep` and `evaluatePriorSession` for the orchestrator's reattach-on-failure path; every prompt is sent with a self-generated opencode `msg_…` id (see `createOpencodeID`) so failures can be correlated against the actual assistant message via `session.messages()`. The event subscription is supervised: a watchdog re-subscribes (and backfills missed output via `session.messages()`) when the SSE stream ends or stalls while `session.status` still reports the session busy &mdash; the prompt POST and the event stream are on separate `AbortController`s so reconnecting events never disturbs the in-flight prompt.
- `src/lib/state.ts` &mdash; in-memory TUI state, listener pub/sub.
- `src/lib/state-files.ts` &mdash; on-disk stop/resume/branch files under the config dir. **Must call `initStatePaths({ configDir })` before any other export is used.**
- `src/lib/fallback.ts` &mdash; non-TTY linear runner.
- `src/lib/config.ts` &mdash; `looper.yaml` loader; resolves `prompt:` paths relative to config dir.
- `src/lib/sdk-server.ts` &mdash; spawns `opencode serve --port=0`, captures the listening URL from stdout. Has its own timeout; do not block tests on it.
- `src/lib/title.ts` &mdash; throwaway-session title generation. Defaults the title session's `agent` to `looper-title` (see `title-agent.ts`); the title prompt is still passed as a `system` override and the model is still chosen per-provider by the cheap-model heuristic. Naming the agent is what stops opencode applying the default agent's adaptive-thinking variant to reasoning-capable cheap models (which reject it with a 400).
- `src/lib/title-agent.ts` &mdash; materializes the hidden `looper-title` opencode subagent (`mode: subagent`, `hidden: true`, no `variant`) into opencode's GLOBAL agent dir. `main.ts` calls `ensureTitleAgent()` before the server starts.
- `src/lib/event-consumer.ts` &mdash; turns opencode message/part events into print lines. Tool calls are rendered in `tui/agent-stream.ts` as group boxes.
- `src/tui/*` &mdash; opentui renderables. `agent-stream.ts` parses the text stream back into block structure for display; the line format is the contract between `event-consumer.ts` and `agent-stream.ts`.

## Gotchas

- Path semantics: `repoDir = process.cwd()`. `configDir` is resolved (in `main.ts`) from `--config-dir`, else `LOOPER_CONFIG_DIR`, else the first of `$PWD/.looper`, `$PWD/.local/looper`, `$PWD/.local/.looper` that already holds a config file, else defaults to `$PWD/.looper`. State files live in `configDir`. The CLI auto-creates `configDir` but fails with exit 2 if no config file is present. Config file resolution prefers `looper.yml`, then `looper.yaml`, `.looper.yml`, `.looper.yaml` (see `CONFIG_FILE_NAMES`/`findConfigFile` in `config.ts`).
- `bin/looper` is a bash wrapper that resolves symlinks itself; symlink it from `~/.local/bin/looper` and it still finds `src/main.ts`.
- `noUncheckedIndexedAccess: true` is on. `frames[i]` from a literal array still needs `!`.
- Runner's `LOOPER_CONTINUATION_EXIT_GRACE_MS` window decides how long to wait after an opencode step ends for a background-task record. Don't shorten it in tests unless you mock the file.
- `event-consumer.ts` debug logs gate on `LOOPER_DEBUG_EVENTS=1`.
- `ensureTitleAgent()` (`title-agent.ts`) writes `looper-title.md` into opencode's GLOBAL agent dir (`$XDG_CONFIG_HOME/opencode/agent`, else `~/.config/opencode/agent`) at startup &mdash; a side effect outside `configDir`/`repoDir`. It only overwrites a file carrying its own managed marker, never a user-authored `looper-title.md`. Caveat: it's written before looper *spawns* opencode, so the spawn path picks it up at boot; on the `--attach`/`attachUrl` path the already-running server may not have loaded it, in which case title gen degrades to no-title (best-effort) rather than breaking the loop.
- The runner's event watchdog is tunable via `LOOPER_EVENT_WATCHDOG_POLL_MS` (default 15s), `LOOPER_EVENT_STALL_MS` (default 45s; how long no events may pass before it probes `session.status`), and `LOOPER_EVENT_RESUBSCRIBE_BACKOFF_MS` (default 1s floor between reconnects). A stream that ends cleanly triggers an immediate probe regardless of the stall window. `createSessionEventConsumer` keeps print/dedup state across reconnects so resubscribe + `backfill()` never double-prints.
- The e2e test uses `agent: build` + `model: openai/gpt-5.5` + `variant: low`. Reasoning-only models (e.g. claude-haiku-4-5) reject the build agent's adaptive-thinking variant with a 400 &mdash; if you change the model, also align the agent/variant.
- Test scratch dirs land under `test/.tmp/` and are auto-cleaned unless `LOOPER_E2E_KEEP=1`.
