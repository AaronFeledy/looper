import type { LooperEvent } from "../core/events.ts";
import { formatLooperEvent } from "../presentation/legacy-line-format.ts";

export const AGENT_MAX_LINES = 5_000;

export type SessionEventBuffer = {
  outputEvents: LooperEvent[];
  outputEventTimes: number[];
  outputLines?: string[];
  outputLineTimes?: number[];
};

export function isLooperOverlayEvent(event: LooperEvent): boolean {
  return event.kind === "looper.log" || event.kind === "continuation.notice";
}

/** Replace session-derived events, keeping Looper overlay logs at the end. */
export function replaceSessionEvents(
  buffer: SessionEventBuffer,
  session: { readonly events: readonly LooperEvent[]; readonly eventTimes: readonly number[] },
): number {
  const overlay: LooperEvent[] = [];
  const overlayTimes: number[] = [];
  for (let index = 0; index < buffer.outputEvents.length; index += 1) {
    const event = buffer.outputEvents[index];
    if (event === undefined || !isLooperOverlayEvent(event)) continue;
    overlay.push(event);
    overlayTimes.push(buffer.outputEventTimes[index] ?? Date.now());
  }
  const overlayStart = Math.max(0, overlay.length - AGENT_MAX_LINES);
  const sessionStart = Math.max(0, session.events.length - (AGENT_MAX_LINES - (overlay.length - overlayStart)));
  const nextEvents = [...session.events.slice(sessionStart), ...overlay.slice(overlayStart)];
  const nextTimes = [
    ...session.events.slice(sessionStart).map((_, index) => session.eventTimes[sessionStart + index] ?? Date.now()),
    ...overlayTimes.slice(overlayStart),
  ];
  buffer.outputEvents.splice(0, buffer.outputEvents.length, ...nextEvents);
  buffer.outputEventTimes.splice(0, buffer.outputEventTimes.length, ...nextTimes);

  const lines = buffer.outputLines;
  const lineTimes = buffer.outputLineTimes;
  const removedEvents = sessionStart + overlayStart;
  if (lines === undefined || lineTimes === undefined) return removedEvents;
  const nextLines: string[] = [];
  const nextLineTimes: number[] = [];
  for (let index = 0; index < nextEvents.length; index += 1) {
    const event = nextEvents[index];
    if (event === undefined) continue;
    const at = nextTimes[index] ?? Date.now();
    for (const line of formatLooperEvent(event, at)) {
      nextLines.push(line);
      nextLineTimes.push(at);
    }
  }
  lines.splice(0, lines.length, ...nextLines.slice(-AGENT_MAX_LINES));
  lineTimes.splice(0, lineTimes.length, ...nextLineTimes.slice(-AGENT_MAX_LINES));
  return Math.max(removedEvents, nextLines.length - AGENT_MAX_LINES);
}
