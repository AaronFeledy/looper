# Constellation: an experimental agent view

Enable it for a normal run:

```sh
LOOPER_UI=constellation looper
```

Try the actual terminal interface with simulated activity, transcripts, and session metadata, without an OpenCode server:

```sh
bun run demo:constellation
```

The default interface stays available when the environment variable is unset. The flag affects the TTY presentation only; configuration still uses `steps:`, and scheduling, retries, gates, and permissions keep their existing behavior.

## How it works

The center is a working constellation. Steps become named agents, with their delegated sessions arranged around them. The top-level agent leads its family. Subagents display their session title when it has been customized; OpenCode’s default timestamp titles fall back to the agent name. Active subagents sit below it in smaller bubbles with their own summaries, and grandchildren stay below their actual parent. A lone subagent is centered directly below its parent. Solid connections show actual delegation, including grandchildren. Siblings share a single trunk with short branches to each row; narrow lists use an outer gutter. Nested families occupy their own column or vertical block so their links stay separate. Working agents carry a fixed bold ◎ ring beside their name, pulsing only its color from gray into the border color. A soft highlight travels clockwise around the border with a fading wake; their satellites follow with a slight delay. Bubble backgrounds stay steady. Slow color gradients flow along the connections and across activity text, while text positions stay steady between handoffs. Dotted connections trace the sequence of configured agents.

Every running agent has its own short activity phrase. Idle subagents fold into their immediate parent, including when that parent is itself a subagent. The bottom row shows ▸ N sub agents for completed direct children. Click the count or press Tab with that parent selected to unfold its children; click or Tab again to fold them away. Opened children are dim, keep their session titles, and remain inspectable. A running descendant and its ancestry always stay visible, regardless of drawer state. On a handoff, the whole family slides left and fades as the next agent slides into the center. In the Trail, opening a parent slides out an indented drawer underneath it, pushing older families down. Nested parents have their own inline arrow/count toggles. Sidebar families have a single separator dot between top-level parents and no child connector lines. The newest completed agent takes the first past slot, older families shift down, and the next queue shifts up. The eased transition takes about three quarters of a second; connections follow the moving bubbles. Timed-out attempts stay in the trail with a red ✗ and “Timed out”; their replacement runs as a separate agent. Manual restarts show ↻ and “Restarted”. These outcomes also appear in the classic list, full-output summary, and details. Child sessions remain available for inspection through the end of the iteration. “Idle” describes the server session's activity, rather than claiming that its work passed.

Changes, PR status, story progress, and the work plan sit in small context capsules. Click Changes, PR, or Stories to see their complete details in the inspector's Context tab. The agent responsible for a permission or question carries a “needs you” badge; the existing permission dialog handles the response.

## Agent inspector

Double-click any bubble, or select it and press Enter or `o`. A large modal opens over the map without rearranging it. Escape, `o`, the close button, or clicking outside returns to the map.

- **Output:** a fixed activity summary just inside the bottom border, using the same moving gradient as the bubbles, beneath the existing transcript renderer, including full available output, expandable tool results, reasoning blocks, timing, usage, scrollback, mouse selection, and follow mode.
- **Details:** the session's reported model and variant, role, status, parent relationship, title, timing, timeout, continuation/restart information, and latest message usage.
- **Prompt:** the exact stored Looper prompt for a configured agent, or the original user prompt fetched from a child's session.
- **Context:** complete changes, PR title/link/state, all CI counts, mergeability, Bugbot, story progress and iteration gains, and the full work plan.

Click the underlined session ID in Details to open that session in OpenCode Desktop using its registered `opencode://` handler. This also works with Looper in WSL and the desktop app on Windows.

Model and variant come from the selected session's message metadata. Requested settings are explicitly labeled when no corresponding assistant value has been reported. Missing values say “not reported”; no configured default is presented as the running model. Refresh failures keep the last available metadata and show an error in Details.

The inspector stays attached to the selected agent while other agents advance. At an iteration reset it closes rather than silently switching to replacement rows. Existing history, configuration, prompts, and permission dialogs remain available. Higher-priority dialogs temporarily take focus; closing them returns to the inspector.

## Controls

| Control | Action |
| --- | --- |
| Up/Down, Left/Right on the map | Select a visible agent, prioritizing active agents |
| Tab or click a child count | Fold/unfold that parent’s completed direct children; Tab selects the next agent when there are no folded children |
| Click a bubble | Select that agent |
| Double-click, Enter, `o` | Open the selected agent's inspector |
| Escape, `o`, close button, click outside | Close the inspector |
| `1`–`4`, Tab/Shift+Tab, Left/Right in inspector | Change inspector tab |
| Up/Down, PageUp/PageDown, Home/End in inspector | Scroll the current tab |
| `v` in inspector | Show the agent's prompt |
| `b` on map | Open Context |
| `b` in Context | Open the PR in your browser |
| `c` | Show complete Looper configuration |
| `i`, or click the Plan capsule | Open or close the current work plan |
| Up/Down, PageUp/PageDown, Home/End with plan open | Scroll the plan |
| `m` | Toggle animation |
| `h` | Existing iteration history |
| `g` | Run / resume |
| `?` | All controls, including pause/restart/skip |

Run controls remain available after closing the inspector. Escape closes the inspector without entering the run's stop/reset confirmation. Ctrl+C copies selected output text; with no selection, it closes the inspector.

In the demo, press `g` to advance to the next agent and try the handoff.

Use `LOOPER_REDUCED_MOTION=1` to start with animation disabled, including sliding transitions. Resizing the terminal and starting a new iteration settle the layout immediately. Animation pauses while a modal has focus.

In wide terminals, the first top-level agent in Trail and Up Next stays pinned. Everything beneath each pinned agent scrolls independently with the mouse wheel, including its compact subagents. The center has its own scroll area. Keyboard selection reveals an agent in its own area without scrolling the others. Scrollbar tracks are hidden throughout both UIs. Small ↑/↓ hints on pane edges appear only when content remains above or below. Each new hint gives two gentle color pulses, then stays steady (reduced motion keeps it steady throughout); output summaries stay on the bottom interior row. Below 106 columns, the family groups and side sections share a vertical scroll area. A terminal around 140 × 34 shows the sample's five simultaneous activities comfortably. The inspector adapts to the terminal width, with wrapping and scrolling for its complete details.

## Activity and data loading

Summaries use structured tool events and short announced actions. Examples include “Running unit tests”, “Checking types”, and “Editing Button.tsx”. Arbitrary tool output, user prompts, and unstructured reasoning text are not copied into the bubbles; recognized result metadata can supply a short description or diagnostic count/status. Unrecognized actions receive conservative labels such as “Running a command” or “Preparing a response”. These are activity hints, not model-generated reports or success verdicts.

Within the configured `prd:` directory, summaries describe file purpose: `prd.json` is the PRD task list, and `progress.txt` holds agent handoff notes, progress, and issues. Story Markdown files (`*-stories.md`, `user-stories.md`, `US-609E0-*.md`) describe user stories and acceptance criteria; PRD indexes describe the plan and dependencies; `spec-*.md` describes the technical specification. Other files, including nested reference fixtures, use PRD reference/design wording. Reads review that material; writes update it; completed edits review the changes without claiming the story passed. These rules cover file tools, patches, and recognizable literal shell reads/writes (including `cd`, working directories, and note-appending heredocs). Opaque scripts and mixed implementation/PRD operations keep their ordinary summaries. Same-named files elsewhere do not receive these labels.

The parent uses its existing live event buffer. A separate child activity feed fetches at most six recent messages per child, roughly every three seconds, with four requests at a time and an eight-second request timeout. It prioritizes the oldest observations so slow requests cannot starve later agents. Idle sessions get a final observation, then stop polling. If an observation gets older than fifteen seconds, its bubble says “Last:”.

Full child transcripts load only when inspected and refresh every three seconds. Closing the inspector releases the selected child's output buffer, leaving its small activity summary available. Parent inspection fetches only six recent messages for metadata and never replaces its authoritative live output. In-flight requests are cancelled on close or teardown, and stale replies cannot mutate replacement rows. The existing transcript retention limits still apply.

The classic UI also shows the fixed activity row in its output pane, including for selected subagents. The row stays visible while scrolling and animates even when follow mode is off. Completed, idle, waiting, and historical output use a static status; reduced-motion mode keeps the row static. Both presentations share the summary and gradient code. Classic mode summarizes the selected child’s existing transcript without adding activity-feed requests.

No additional model calls or production dependencies are required.

Implementation lives in `src/core/agent-activity.ts`, `src/lib/agent-activity-feed.ts`, `src/lib/session-inspection.ts`, `src/lib/background-agent-stream.ts`, `src/presentation/tui/constellation.ts`, `src/presentation/tui/constellation-transition.ts`, `src/presentation/tui/agent-inspector.ts`, `src/tui/constellation.ts`, and `src/tui/agent-inspector.ts`. The demo and snapshot tool use the production renderers.


Runtime warnings, console messages, and stderr output are captured while the TUI is active. Press **l** or click the footer’s diagnostics indicator to inspect timestamps, severity, messages, and available stack traces. New warnings/errors light up the indicator; **Esc** or **l** closes the window, and arrow/page keys scroll it. Permission and recovery dialogs retain priority. Both UIs keep the most recent 200 entries in memory, group adjacent repeats, and truncate oversized messages. Capture restores the original console/stderr methods when the TUI closes; fatal errors that unwind the runner are still reported after terminal teardown.

The Changes card includes the changed-file count alongside additions/deletions. Both UIs exclude the configured PRD directory’s progress.txt and prd.json from all three totals, so updates to those bookkeeping files neither activate nor pulse Changes. Other files in that directory and same-named files elsewhere remain included. While CI has unfinished checks, the PR border pulses and its summary shows ◷ pending, ✓ passing, ✗ failing, and ~ neutral counts. A failing overall result does not hide checks still running. When checks settle, the dock gives a brief result-change pulse before becoming steady; reduced motion keeps a steady highlight. The classic PR panel also shows these counts and border feedback.

### Adding activity parsers

The registry in `src/core/activity-parsers.ts` is ordered from specific rules to generic fallbacks. Each `ActivityParser` has an ID and returns a string, an array of alternate strings, `undefined` to let the next parser try, or `null` to ignore the event and keep looking backward. Add a rule before the fallback; use `toolParser` to share handling across tool aliases and running/done/failed phases:

```ts
toolParser("schema-validation", ["validate_schema"], ({ input, phase }) =>
  typeof input.name === "string"
    ? (phase === "done" ? "Reviewing schema: " : "Validating schema: ") + input.name
    : ["Checking schema structure", "Validating the schema"]),
```

`parseActivity` exposes the winning parser ID and candidate phrases for debugging and tests. `createActivitySummarizer({ parsers, random })` supports an explicit registry and injectable random source. Production uses `summarizeAgentActivity(owner, events, context)`, with `state.activityContext` carrying the runtime repo/PRD paths to both UIs and the child feed. `activityParsersFor(context)` prepends the PRD rules and scopes parsed-event caches to that registry; contexts are immutable and replaced when configuration changes. There is one weakly owned selector shared by the feed, bubbles, and full-output pane. It randomly chooses once when the semantic activity changes, holds the choice across animation frames and refetched snapshots, and resets when the transcript is cleared. Generic reasoning and response phases have alternate wording; a standalone reasoning label enclosed in matching single or double asterisks (at most seven words and 100 characters) is shown directly without the asterisks. Longer, multiline, partial, or unformatted reasoning keeps the generic wording. `summarizeActivity` is a stateless first-candidate preview.

The initial rules were informed by 12 recent Looper-tagged steps and their descendants (86 sessions, 2,157 tool calls in the initial sample). The main patterns were file reads, shell commands, grep, task-plan updates, delegation/background results, codegraph exploration, skills, and LSP diagnostics. Sanitized regression cases live in `test/agent-activity-parsers.test.ts`; tests never depend on a user's OpenCode database.

Completed and failed tool events retain their own optional input from the SDK part. This avoids guessing which earlier call belongs to a result when calls overlap, and works for completed-only snapshots. Examples include “Reviewing recipe.ts”, “Watching CI for PR 924”, “Verifying cleanup changes”, and “Mapping relationships across 3 files”. Known result formats may expose short metadata: the task-result description header, task-plan JSON active form or lock error, and the exact “No diagnostics found” response. Arbitrary tool-result bodies are not copied. A completed test command says “Reviewing test results”, without claiming tests or the step passed. Turn-level `step.done` bookkeeping leaves the last activity in place.

Turn-start events only show startup wording before the first activity. Later starts retain the previous summary, changing review/inspection phrases to past tense (for example, “Reviewing recipe.ts” → “Reviewed recipe.ts”). Empty assistant/reasoning block-start events preserve that context until real text or a tool event arrives. Owner-scoped memory also carries it across bounded child polling windows; clearing the transcript resets it. These tense changes never declare a build, edit, test run, or whole step successful.

Active bubbles grow with terminal width: configured steps range from compact 34-column cards (clamped further on tiny screens) to 72 columns, and active children grow up to 56 columns within their family lanes. Children remain narrower than the top-level step. Subagents with their own completed children gain a bottom count row. Past/up-next cards and the Trail’s indented child drawers retain their compact sizing.

Crowded child groups use narrower cards in tight family lanes, allowing two columns with as little as 52 columns of space. Each active child keeps its title and summary rows; a lone child stays centered beneath its parent.

Only the left Trail and right Up Next scrollable sections replace their scrollbar tracks with centered ▲/▼ overflow hints at the top and bottom. The hints occupy reserved rows below the pinned heads and above the dock, leaving agent text clear. The center, output, inspector, plan, and dialogs use standard scrollbars.

### Bottom-panel feedback

Empty panels use dim borders and text. Useful content gets a steady accent; a semantic value change triggers two fading border/text pulses over 1.6 seconds. Returning to empty cancels any pulse immediately. Identical polling results never retrigger animation, and reduced motion uses steady colors.

| Panel | Bright while | Pulses when |
| --- | --- | --- |
| Changes | Any changed files or added/deleted lines exist | The displayed file/addition/deletion totals or branch change |
| PR | An associated PR exists | PR identity, title, draft/state, mergeability, CI counts/results, or Bugbot status change |
| Stories | The story total is nonzero | Completed/remaining progress or the total changes |
| Plan | Tasks exist | Task text, order, priority, or status changes, even if completed counts stay the same |

Completed Stories and Plans settle to green. Unavailable data uses an attention color. PR failures, conflicts, and outstanding Bugbot issues receive a failure accent; running CI retains its ongoing warm border pulse. When CI settles, the result gets the normal brief change pulse before becoming steady. Initial useful content also pulses once it appears.

The semantic panel descriptions live in `src/presentation/tui/constellation-dock.ts`; `src/tui/dock-feedback.ts` owns per-panel change detection and color sampling. Both use the view's existing animation loop, including when the agent stage is quiet; no extra timers or polling requests are created.

The Up Next column looks ahead one iteration. After the current queue, a borderless ↻ divider labels the next iteration, followed by its configured agents. These previews carry the iteration number and do not select a current session. The divider scrolls with the queue, then occupies the pinned top slot when the current queue empties. There is no further preview on the final iteration or when stop-after-iteration is enabled. Retries, adjudication rows, and subagents are not copied into the preview.


Completed step agents remain in the Trail across iterations and process exits. Their terminal statuses, session IDs, timestamps, prompts, and child relationships are saved in the config directory's `.looper-agents.json`. This file is separate from the advancing resume pointer, so completing a run or reaching the iteration limit does not erase the Trail. `--fresh` and the TUI fresh reset clear it. The classic step list also shows retained agents; inspecting an archived session loads its transcript from OpenCode on demand.

Completed bubbles show their saved duration right-aligned inside the title line; long titles truncate with `...` before the duration. Older checkpoints without timestamps recover them from OpenCode in the background when the session remains available, then save the repaired timestamps for later restarts.
