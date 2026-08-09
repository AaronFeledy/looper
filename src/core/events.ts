export type StepTokenUsage = {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

export type LooperEvent =
  | { readonly kind: "step.started" }
  | { readonly kind: "step.done"; readonly reason: string; readonly cost: number; readonly tokens: StepTokenUsage }
  | { readonly kind: "step.failed"; readonly message: string }
  | { readonly kind: "assistant.started" }
  | { readonly kind: "assistant.text"; readonly text: string }
  | { readonly kind: "assistant.error"; readonly message: string }
  | { readonly kind: "assistant.aborted"; readonly message: string }
  | { readonly kind: "user.started" }
  | { readonly kind: "user.text"; readonly text: string }
  | { readonly kind: "reasoning.started" }
  | { readonly kind: "reasoning.text"; readonly text: string }
  | { readonly kind: "tool.started"; readonly tool: string; readonly input: Record<string, unknown> }
  | { readonly kind: "tool.done"; readonly tool: string; readonly output: string; readonly retainedOutputPath?: string }
  | { readonly kind: "tool.failed"; readonly tool: string; readonly error: string }
  | { readonly kind: "session.error"; readonly message: string }
  | { readonly kind: "retry"; readonly attempt: number; readonly message: string }
  | { readonly kind: "debug.event"; readonly eventType: string; readonly sessionID?: string }
  | { readonly kind: "looper.log"; readonly message: string }
  | { readonly kind: "looper.error"; readonly message: string }
  | {
      readonly kind: "continuation.notice";
      readonly prefix: string;
      readonly sessionID: string;
      readonly state: string;
      readonly reason?: string;
      readonly updatedAt: string;
    };

/** Derives a `looper.log` event from a raw `[looper] ...` output line, or null for any other line. */
export function looperLogEventFromLine(line: string): LooperEvent | null {
  const prefix = "[looper] ";
  if (!line.startsWith(prefix)) return null;
  return { kind: "looper.log", message: line.slice(prefix.length) };
}
