import { prdPassingGain, type GithubPr, type LoopState } from "../../lib/state.ts";
import { ciCounts } from "./ci-progress.ts";

export type DockPanel = {
  id: "changes" | "pr" | "stories" | "plan";
  content: string;
  active: boolean;
  tone: "activity" | "success" | "attention" | "failure";
  key: string;
  continuous: boolean;
};

/** Short review-state suffixes the former PR sidebar showed as their own rows. */
function prReviewNotes(pr: GithubPr): string[] {
  const notes: string[] = [];
  if (pr.mergeable === "conflicting") notes.push("conflicts");
  const bugbot = pr.bugbot;
  if (bugbot?.state === "pending") notes.push("bugbot running");
  else if (bugbot?.state === "error") notes.push("bugbot error");
  else if (bugbot?.state === "issues") notes.push(bugbot.unresolved === undefined ? "bugbot issues" : `bugbot ${bugbot.unresolved} unresolved`);
  else if (bugbot?.state === "clean") notes.push("bugbot clean");
  return notes;
}

/** Compare meaningful values, not watcher object identity or polling timestamps. */
export function constellationDockPanels(state: LoopState): DockPanel[] {
  const { branchDiff: diff, github, prd, todos } = state;
  const changed = diff.kind === "ok" && (diff.files > 0 || diff.additions > 0 || diff.deletions > 0);
  const pr = github.kind === "pr" ? github.pr : undefined;
  const checking = !!pr && (pr.ciPending > 0 || pr.ciOverall === "pending");
  const completed = todos.filter(todo => todo.status === "completed").length;
  const gain = prdPassingGain(prd, state.prdIterationBaseline);
  return [
    {
      id: "changes",
      content: diff.kind === "ok" ? "Changes  " + diff.files + " file" + (diff.files === 1 ? "" : "s") + " · +" + diff.additions + " −" + diff.deletions
        : diff.kind === "error" ? "Changes · unavailable" : "Changes  ·",
      active: changed || diff.kind === "error",
      tone: diff.kind === "error" ? "attention" : "activity",
      key: JSON.stringify([state.branch, diff.kind, diff.kind === "ok" ? [diff.files, diff.additions, diff.deletions] : diff.kind === "error" ? diff.message : null]),
      continuous: false,
    },
    {
      id: "pr",
      content: pr ? ["PR #" + pr.number, checking ? "CI " + ciCounts(pr) : pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft · " + pr.ciOverall : pr.ciOverall, ...prReviewNotes(pr)].join(" · ")
        : github.kind === "error" ? "PR · unavailable" : "PR · none",
      active: !!pr || github.kind === "error",
      tone: checking ? "attention" : github.kind === "error" ? "attention"
        : pr?.ciOverall === "failing" || pr?.ciFailing || pr?.mergeable === "conflicting" || pr?.bugbot?.state === "issues" ? "failure"
        : pr?.state === "MERGED" || pr?.ciOverall === "passing" ? "success" : "activity",
      key: JSON.stringify([state.branch, github.kind, pr ? [
        pr.number, pr.title, pr.url, pr.state, pr.isDraft, pr.mergeable,
        pr.ciOverall, pr.ciPending, pr.ciPassing, pr.ciFailing, pr.ciNeutral, pr.ciTotal,
        pr.bugbot?.state, pr.bugbot?.unresolved,
      ] : github.kind === "error" ? github.message : null]),
      continuous: checking,
    },
    {
      id: "stories",
      // The former PRD sidebar flagged one advance per iteration with ✓ and more than one with ⚠, since a
      // single iteration should complete at most one story.
      content: prd.kind === "ok" ? "Stories  " + (prd.total - prd.remaining) + "/" + prd.total + " complete" + (gain >= 2 ? " · ⚠ +" + gain : gain === 1 ? " · +1 ✓" : "")
        : prd.kind === "error" ? "Stories · unavailable" : "Stories  ·",
      active: prd.kind === "ok" ? prd.total > 0 : prd.kind === "error",
      tone: prd.kind === "error" ? "attention" : gain >= 2 ? "failure" : prd.kind === "ok" && prd.remaining === 0 ? "success" : "activity",
      key: JSON.stringify([prd.kind, prd.kind === "ok" ? [prd.remaining, prd.total, prd.terminal, gain] : prd.kind === "error" ? prd.message : null]),
      continuous: false,
    },
    {
      id: "plan", content: "Plan  " + completed + "/" + todos.length + " · i",
      active: todos.length > 0, tone: completed === todos.length ? "success" : "activity",
      key: JSON.stringify(todos.map(todo => [todo.content, todo.status, todo.priority])),
      continuous: false,
    },
  ];
}
