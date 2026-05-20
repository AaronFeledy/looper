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
- `src/lib/runner.ts` &mdash; runs one step against opencode (session create, prompt, subscribe to events, abort on cancel). Reads `.sisyphus/run-continuation/*.json` from the project repo to detect background tasks. Also exports `reattachOpenCodeStep` and `evaluatePriorSession` for the orchestrator's reattach-on-failure path; every prompt is sent with a self-generated opencode `msg_…` id (see `createOpencodeID`) so failures can be correlated against the actual assistant message via `session.messages()`.
- `src/lib/state.ts` &mdash; in-memory TUI state, listener pub/sub.
- `src/lib/state-files.ts` &mdash; on-disk stop/resume/branch files under the config dir. **Must call `initStatePaths({ configDir })` before any other export is used.**
- `src/lib/fallback.ts` &mdash; non-TTY linear runner.
- `src/lib/config.ts` &mdash; `looper.yaml` loader; resolves `prompt:` paths relative to config dir.
- `src/lib/sdk-server.ts` &mdash; spawns `opencode serve --port=0`, captures the listening URL from stdout. Has its own timeout; do not block tests on it.
- `src/lib/event-consumer.ts` &mdash; turns opencode message/part events into print lines. Tool calls are rendered in `tui/agent-stream.ts` as group boxes.
- `src/tui/*` &mdash; opentui renderables. `agent-stream.ts` parses the text stream back into block structure for display; the line format is the contract between `event-consumer.ts` and `agent-stream.ts`.

## Gotchas

- Path semantics: `repoDir = process.cwd()`, `configDir = $PWD/.local/looper`. State files live in `configDir`. The CLI auto-creates `configDir` but fails with exit 2 if `looper.yaml` is missing.
- `bin/looper` is a bash wrapper that resolves symlinks itself; symlink it from `~/.local/bin/looper` and it still finds `src/main.ts`.
- `noUncheckedIndexedAccess: true` is on. `frames[i]` from a literal array still needs `!`.
- Runner's `LOOPER_CONTINUATION_EXIT_GRACE_MS` window decides how long to wait after an opencode step ends for a background-task record. Don't shorten it in tests unless you mock the file.
- `event-consumer.ts` debug logs gate on `LOOPER_DEBUG_EVENTS=1`.
- The e2e test uses `agent: build` + `model: openai/gpt-5.5` + `variant: low`. Reasoning-only models (e.g. claude-haiku-4-5) reject the build agent's adaptive-thinking variant with a 400 &mdash; if you change the model, also align the agent/variant.
- Test scratch dirs land under `test/.tmp/` and are auto-cleaned unless `LOOPER_E2E_KEEP=1`.
