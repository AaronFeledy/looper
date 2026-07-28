import type { BackgroundAgent, LoopStep } from "../../lib/state.ts";
import { backgroundAgentLabel } from "../../lib/state.ts";

export const MAX_DISPLAY_DEPTH = 3;
const MAX_CONTINUATION_LENGTH = 12;

export function agentRowLabel(agent: BackgroundAgent, frame: string): string {
  const displayDepth = Math.min(Math.max(agent.depth, 1), MAX_DISPLAY_DEPTH);
  const prefix = "  ".repeat(displayDepth - 1);
  const glyph = agent.activity === "idle" ? "✓" : frame;
  return `${prefix}↳ ${glyph} ${backgroundAgentLabel(agent)}`;
}

export function isIdleBackgroundAgent(agent: BackgroundAgent): boolean {
  return agent.activity === "idle";
}

export function continuationIndicatorText(step: LoopStep): string {
  const reason = step.continuation?.reason;
  if (reason === undefined || reason.length <= MAX_CONTINUATION_LENGTH) return reason ?? "";
  return `${reason.slice(0, MAX_CONTINUATION_LENGTH - 1)}…`;
}
