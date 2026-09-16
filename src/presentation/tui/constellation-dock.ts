import type { LoopState } from "../../lib/state.ts";

export type DockPanel = {
  id: "changes" | "pr" | "stories" | "plan";
  content: string;
  active: boolean;
  tone: "activity" | "success" | "attention" | "failure";
  key: string;
  continuous: boolean;
};

/** Compare meaningful values, not watcher object identity or polling timestamps. */
export function constellationDockPanels(state: LoopState): DockPanel[] {
  const { branchDiff: diff, github, prd, todos } = state;
  const changed = diff.kind === "ok" && (diff.files > 0 || diff.additions > 0 || diff.deletions > 0);
  const pr = github.kind === "pr" ? github.pr : undefined;
  const checking = !!pr && (pr.ciPending > 0 || pr.ciOverall === "pending");
  const completed = todos.filter(todo => todo.status === "completed").length;
  const counts = pr ? "◷" + pr.ciPending + " ✓" + pr.ciPassing + " ✗" + pr.ciFailing + (pr.ciNeutral ? " ~" + pr.ciNeutral : "") : "";
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
      content: pr ? "PR #" + pr.number + " · " + (checking ? "CI " + counts : pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft · " + pr.ciOverall : pr.ciOverall)
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
      content: prd.kind === "ok" ? "Stories  " + (prd.total - prd.remaining) + "/" + prd.total + " complete" : prd.kind === "error" ? "Stories · unavailable" : "Stories  ·",
      active: prd.kind === "ok" ? prd.total > 0 : prd.kind === "error",
      tone: prd.kind === "error" ? "attention" : prd.kind === "ok" && prd.remaining === 0 ? "success" : "activity",
      key: JSON.stringify([prd.kind, prd.kind === "ok" ? [prd.remaining, prd.total, prd.terminal] : prd.kind === "error" ? prd.message : null]),
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
