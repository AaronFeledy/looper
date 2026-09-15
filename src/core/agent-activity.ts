import type { LooperEvent } from "./events.ts";
import type { ActivityParser } from "./activity-parser.ts";
import { compactActivity } from "./activity-format.ts";
import type { ActivityContext } from "./prd-activity.ts";
export type { ActivityContext } from "./prd-activity.ts";
import { activityParsersFor, defaultActivityParsers } from "./activity-parsers.ts";
export { compactActivity } from "./activity-format.ts";
export { toolParser } from "./activity-parser.ts";
export type { ActivityParser, ActivityMessages } from "./activity-parser.ts";
export { defaultActivityParsers } from "./activity-parsers.ts";

/** A bounded presentation hint, never an instruction or a completion verdict. */
export type AgentActivitySummary = { text: string; observedAt: number };
export type ParsedActivity = { parserID: string; messages: readonly string[] };

// Events are immutable. Avoid rescanning a large patch on every animation frame.
// Refetched snapshots are new objects and are parsed again; weak entries retain no history.
const parserCaches = new WeakMap<readonly ActivityParser[], WeakMap<LooperEvent, ParsedActivity | null>>();
function parseEvent(event: LooperEvent, parsers: readonly ActivityParser[]): ParsedActivity | null {
  for (const parser of parsers) {
    const result = parser.parse(event);
    if (result === null) return null;
    if (result === undefined) continue;
    const messages = [...new Set((typeof result === "string" ? [result] : result).map((s) => compactActivity(s)).filter(Boolean))];
    if (messages.length) return { parserID: parser.id, messages };
  }
  return null;
}

/** Only observation verbs change tense: a new turn never proves a build or edit succeeded. */
function afterTurnText(text: string): string {
  const past: Record<string, string> = { reviewing: "Reviewed", inspecting: "Inspected", examining: "Examined" };
  return text.replace(/^(reviewing|inspecting|examining)\b/i, (verb) => past[verb.toLowerCase()]!);
}
function afterTurn(activity: ParsedActivity): ParsedActivity {
  if (activity.parserID === "step-start") return {
    parserID: "continuing-turn", messages: ["Continuing work", "Working through the next step", "Following up on the last activity"],
  };
  return {
    parserID: activity.parserID.startsWith("after-turn:") ? activity.parserID : "after-turn:" + activity.parserID,
    messages: activity.messages.map(afterTurnText),
  };
}

function findActivity(
  events: readonly LooperEvent[], parsers: readonly ActivityParser[], previous?: ParsedActivity,
): ParsedActivity | undefined {
  let parsedEvents = parserCaches.get(parsers);
  if (!parsedEvents) { parsedEvents = new WeakMap(); parserCaches.set(parsers, parsedEvents); }
  let turnStarted = false;
  let starts = 0;
  let initial: ParsedActivity | undefined;
  for (let i = events.length - 1; i >= Math.max(0, events.length - 100); i--) {
    const event = events[i]!;
    if (!parsedEvents.has(event)) parsedEvents.set(event, parseEvent(event, parsers));
    const activity = parsedEvents.get(event)!;
    if (!activity) continue;
    if (event.kind === "step.started" && activity.parserID === "step-start") {
      initial ??= activity;
      turnStarted = true;
      starts++;
      continue;
    }
    // These mark empty content blocks, not a new action. Wait for text/tool
    // content before replacing the useful summary already on screen.
    if ((event.kind === "assistant.started" || event.kind === "reasoning.started") && activity.parserID === "fallback") {
      initial ??= activity;
      continue;
    }
    return turnStarted ? afterTurn(activity) : activity;
  }
  // A bounded child snapshot may no longer contain the preceding activity.
  // Its owner-scoped selector still remembers it across polling windows.
  if (previous) return turnStarted && (previous.parserID !== "step-start" || starts > 1) ? afterTurn(previous) : previous;
  return (starts > 1 || events.length > 100) && initial ? afterTurn(initial) : initial;
}

/** First matching parser wins; turn boundaries carry the prior activity forward. */
export function parseActivity(events: readonly LooperEvent[], parsers = defaultActivityParsers): ParsedActivity | undefined {
  return findActivity(events, parsers);
}

/** Stateless preview: first wording, useful for fixtures and individual parser callers. */
export function summarizeActivity(events: readonly LooperEvent[], context?: ActivityContext): string | undefined {
  return parseActivity(events, activityParsersFor(context))?.messages[0];
}
export function toolActivity(tool: string, input: Record<string, unknown>, context?: ActivityContext): string {
  return summarizeActivity([{ kind: "tool.started", tool, input }], context)!;
}

/** Picks once per semantic activity change, stable across repaint and refetched event objects. */
export function createActivitySummarizer({
  context, parsers = activityParsersFor(context), random = Math.random,
}: { context?: ActivityContext; parsers?: readonly ActivityParser[]; random?: () => number } = {}) {
  let previousKey: string | undefined;
  let previousText: string | undefined;
  let previousActivity: ParsedActivity | undefined;
  return (events: readonly LooperEvent[]): string | undefined => {
    if (!events.length) {
      previousKey = undefined;
      previousText = undefined;
      previousActivity = undefined;
      return undefined;
    }
    const activity = findActivity(events, parsers, previousActivity);
    if (!activity) return previousText;
    const key = JSON.stringify([activity.parserID, activity.messages]);
    if (key !== previousKey) {
      previousKey = key;
      const carried = previousText && activity.parserID.startsWith("after-turn:") ? afterTurnText(previousText) : undefined;
      const sample = activity.messages.length > 1 && !(carried && activity.messages.includes(carried)) ? random() : 0;
      const index = Number.isFinite(sample) ? Math.min(activity.messages.length - 1, Math.max(0, Math.floor(sample * activity.messages.length))) : 0;
      previousText = carried && activity.messages.includes(carried) ? carried : activity.messages[index];
    }
    previousActivity = activity;
    return previousText;
  };
}

// Shared by both UI surfaces and the bounded feed; released with its step/child.
const summarizers = new WeakMap<object, { parsers: readonly ActivityParser[]; summarize: ReturnType<typeof createActivitySummarizer> }>();
export function summarizeAgentActivity(owner: object, events: readonly LooperEvent[], context?: ActivityContext): string | undefined {
  const parsers = activityParsersFor(context);
  let entry = summarizers.get(owner);
  if (!entry || entry.parsers !== parsers) {
    entry = { parsers, summarize: createActivitySummarizer({ parsers }) };
    summarizers.set(owner, entry);
  }
  return entry.summarize(events);
}
