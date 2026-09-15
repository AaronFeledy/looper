import type { LooperEvent } from "./events.ts";

export type ActivityMessages = string | readonly string[];
/** null ignores an event; undefined lets the next parser try it. */
export type ActivityParser = {
  readonly id: string;
  parse(event: LooperEvent): ActivityMessages | null | undefined;
};
export type ToolActivityEvent = Extract<LooperEvent, { kind: "tool.started" | "tool.done" | "tool.failed" }>;
export type ToolActivityContext = {
  event: ToolActivityEvent;
  input: Record<string, unknown>;
  phase: "running" | "done" | "failed";
};
export function toolParser(
  id: string,
  names: readonly string[] | RegExp,
  parse: (context: ToolActivityContext) => ActivityMessages | undefined,
): ActivityParser {
  return { id, parse(event) {
    if (event.kind !== "tool.started" && event.kind !== "tool.done" && event.kind !== "tool.failed") return;
    const name = event.tool.toLowerCase();
    if (Array.isArray(names) ? !names.includes(name) : !(names as RegExp).test(name)) return;
    return parse({
      event, input: event.input ?? {},
      phase: event.kind === "tool.started" ? "running" : event.kind === "tool.done" ? "done" : "failed",
    });
  } };
}
