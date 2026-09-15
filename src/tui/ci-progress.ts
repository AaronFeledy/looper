import type { GithubPr, GithubStatus } from "../lib/state.ts";

export function ciIsRunning(status: GithubStatus): boolean {
  // GitHub can report an overall failure while other checks are still running.
  return status.kind === "pr" && (status.pr.ciPending > 0 || status.pr.ciOverall === "pending");
}

export function ciCounts(pr: GithubPr): string {
  return `◷${pr.ciPending} ✓${pr.ciPassing} ✗${pr.ciFailing}${pr.ciNeutral ? ` ~${pr.ciNeutral}` : ""}`;
}

/** Slow dim-to-bright border pulse; reduced motion keeps the warm highlight. */
export function ciBorderColor(now: number, reducedMotion: boolean): string {
  const glow = reducedMotion ? 0.65 : 0.2 + 0.8 * (1 - Math.cos(now / 420)) / 2;
  const dim = [83, 96, 111], bright = [249, 226, 175];
  return "#" + dim.map((value, i) => Math.round(value + (bright[i]! - value) * glow).toString(16).padStart(2, "0")).join("");
}
