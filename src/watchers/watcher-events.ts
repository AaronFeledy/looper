export type GithubCiOverall = "none" | "pending" | "passing" | "failing" | "neutral";

export type GithubMergeable = "mergeable" | "conflicting" | "unknown";

export type GithubBugbot = {
  readonly state: "clean" | "issues" | "pending" | "error";
  readonly unresolved?: number;
};

export type GithubPr = {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly url: string;
  readonly ciOverall: GithubCiOverall;
  readonly ciPassing: number;
  readonly ciFailing: number;
  readonly ciPending: number;
  readonly ciNeutral: number;
  readonly ciTotal: number;
  readonly mergeable: GithubMergeable;
  readonly bugbot?: GithubBugbot;
};

export type GithubStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "no-pr" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "pr"; readonly pr: GithubPr };

export type PrdStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly remaining: number; readonly total: number }
  | { readonly kind: "error"; readonly message: string };

export type BranchWatcherEvent = {
  readonly kind: "branch-change";
  readonly branch: string;
};

export type GithubWatcherEvent = {
  readonly kind: "github-status";
  readonly status: GithubStatus;
};

export type PrdWatcherEvent = {
  readonly kind: "prd-status";
  readonly status: PrdStatus;
};

export type WatcherEvent = BranchWatcherEvent | GithubWatcherEvent | PrdWatcherEvent;
