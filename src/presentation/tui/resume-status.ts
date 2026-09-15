import type { LoopState } from "../../lib/state.ts";

export function bootResumeStatus(state: LoopState): { title: string; detail: string; color: string } | undefined {
  const saved = state.bootResumeSession;
  if (state.started || !saved || saved.workState === "idle" || (saved.workState === "running" && saved.canReattach)) return undefined;
  const name = state.steps[saved.stepIndex]?.name ?? "saved step";
  if (saved.workState === "running") return {
    title: `Still running · ${name}`,
    detail: "Saved session is active; reattachment metadata is incomplete · [g] check recovery",
    color: "#91d9df",
  };
  if (saved.workState === "checking") return { title: `Checking saved session · ${name}`, detail: "Checking foreground and delegated work…", color: "#a6adc8" };
  if (saved.workState === "stale") return { title: `Server reports busy · ${name}`, detail: "No recent activity confirmed · [g] check recovery before continuing", color: "#f9e2af" };
  return { title: `Session status unavailable · ${name}`, detail: "Saved work may still be running · [g] recheck before continuing", color: "#f9e2af" };
}
