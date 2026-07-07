import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import type { TitleService } from "./engine-ports.ts";
import type { TitleGenConfig } from "../lib/config.ts";
import type { LooperSessionMetadataInput } from "../lib/session-metadata.ts";

/**
 * Branch names that don't carry useful information for titling. Filtered out
 * before they reach the title prompt so the model isn't tempted to summarize
 * an iteration as "Main" / "Master".
 */
export const TRIVIAL_BRANCH_NAMES = new Set(["main", "master", "dev", "develop", "trunk", "default", "unknown", "detached"]);

export function branchHintFor(branch: string | undefined): string | undefined {
  if (branch === undefined) return undefined;
  const trimmed = branch.trim();
  if (trimmed.length === 0) return undefined;
  if (TRIVIAL_BRANCH_NAMES.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

/**
 * Fallback delay for `title: branch` mode when no branch transition is
 * observed during the step. Matches the spirit of `title: 300`.
 */
export const BRANCH_FALLBACK_SECONDS = 300;

/**
 * How often the branch-mode coordinator re-reads `state.branch` looking for a
 * transition. Branch changes don't need ms-grained detection; 500ms keeps the
 * latency low without burning measurable CPU.
 */
export const BRANCH_POLL_INTERVAL_MS = 500;

export type TitleMode =
  | { readonly kind: "end" }
  | { readonly kind: "delay"; readonly seconds: number }
  | { readonly kind: "branch"; readonly fallbackSeconds: number };

export function titleModeFor(cfg: boolean | number | "branch"): TitleMode | undefined {
  if (cfg === false) return undefined;
  if (cfg === true) return { kind: "end" };
  if (cfg === "branch") return { kind: "branch", fallbackSeconds: BRANCH_FALLBACK_SECONDS };
  return { kind: "delay", seconds: cfg };
}

export class TitleCoordinator {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private branchPollTimer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<string | undefined> | undefined;
  private readonly controller = new AbortController();
  private firstFired = false;
  private finished = false;
  private applied = false;
  private appliedToSessionID: string | undefined;
  private readonly initialBranch: string | undefined;

  constructor(
    private readonly client: OpencodeClient,
    private readonly repoDir: string,
    private readonly mode: TitleMode,
    private readonly titleService: TitleService,
    private readonly getSessionID: () => string | undefined,
    private readonly getBranch: () => string | undefined,
    /** Apply the generated title (state mutation + opencode session.update). Called eagerly the moment generation succeeds, NOT at step end — so TUI and opencode update mid-step. `targetSessionID` pins the opencode rename to the session the title was generated from, so a concurrent restart that reindexes `state.steps` can't redirect or drop it. */
    private readonly applyTitle: (desc: string, targetSessionID?: string) => Promise<void>,
    private readonly log: (line: string) => void,
    private readonly titleGenConfig: TitleGenConfig | undefined,
    private readonly sessionMetadata: Omit<LooperSessionMetadataInput, "purpose" | "parentSessionID"> | undefined,
  ) {
    this.initialBranch = mode.kind === "branch" ? getBranch() : undefined;
    if (mode.kind === "branch") {
      this.branchPollTimer = setInterval(() => this.checkBranchChange(), BRANCH_POLL_INTERVAL_MS);
    }
  }

  readonly onFirstResponse = (): void => {
    if (this.firstFired || this.finished) return;
    this.firstFired = true;
    const delaySeconds =
      this.mode.kind === "delay"
        ? this.mode.seconds
        : this.mode.kind === "branch"
          ? this.mode.fallbackSeconds
          : undefined;
    if (delaySeconds === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.inflight !== undefined) return;
      const sid = this.getSessionID();
      if (sid === undefined) return;
      this.inflight = this.runBranchTitle(sid) ?? this.runGeneration(sid);
    }, delaySeconds * 1000);
  };

  async resolve(finalSessionID: string): Promise<string | undefined> {
    this.finished = true;
    this.clearTimers();
    try {
      if (this.inflight !== undefined) {
        const fromTimer = await this.inflight;
        if (fromTimer !== undefined) {
          // Title was generated and applied mid-step, but if the step retried
          // with a new session, we need to re-apply the title to the final session.
          if (this.appliedToSessionID !== undefined && this.appliedToSessionID !== finalSessionID) {
            try {
              await this.applyTitle(fromTimer, finalSessionID);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              this.log(`[looper] title gen: re-apply to retry session threw: ${message}`);
            }
          }
          return fromTimer;
        }
      }
      return await (this.runBranchTitle(finalSessionID) ?? this.runGeneration(finalSessionID));
    } finally {
      this.clearTimers();
    }
  }

  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    this.controller.abort();
    this.inflight = undefined;
  }

  private checkBranchChange(): void {
    if (this.finished || this.inflight !== undefined) return;
    const current = this.getBranch();
    if (current === undefined || current === this.initialBranch) return;
    const hint = branchHintFor(current);
    if (hint === undefined) return;
    const sid = this.getSessionID();
    if (sid === undefined) return; // session not bound yet; try again next tick
    this.clearBranchPoll();
    this.log(`[looper] title gen: branch changed to ${hint}; applying deterministic title now`);
    this.inflight = this.applyDeterministicBranchTitle(sid, hint);
  }

  private clearTimers(): void {
    this.clearTimer();
    this.clearBranchPoll();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private clearBranchPoll(): void {
    if (this.branchPollTimer !== undefined) {
      clearInterval(this.branchPollTimer);
      this.branchPollTimer = undefined;
    }
  }

  private runBranchTitle(sessionID: string): Promise<string | undefined> | undefined {
    if (this.mode.kind !== "branch") return undefined;
    const hint = branchHintFor(this.getBranch());
    if (hint === undefined) return undefined;
    return this.applyDeterministicBranchTitle(sessionID, hint);
  }

  private async applyDeterministicBranchTitle(sessionID: string, branch: string): Promise<string | undefined> {
    const desc = this.titleService.humanizeBranchName(branch);
    if (desc.length === 0) return undefined;
    if (!this.applied) {
      this.applied = true;
      this.appliedToSessionID = sessionID;
      try {
        await this.applyTitle(desc, sessionID);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`[looper] title gen: applyTitle threw: ${message}`);
      }
    }
    return desc;
  }

  private async runGeneration(sessionID: string): Promise<string | undefined> {
    try {
      const messages = await this.client.session.messages(
        { sessionID, directory: this.repoDir },
        { signal: this.controller.signal },
      );
      if (messages.error || !messages.data) return undefined;
      const text = this.titleService.extractAssistantText(messages.data);
      const stepModel = this.titleService.extractAssistantModel(messages.data);
      const branchHint = branchHintFor(this.getBranch());
      // Skip generation only if BOTH signals are empty. A useful branch alone
      // is enough to produce a good title even before the assistant has said
      // anything substantive.
      if (text.length === 0 && branchHint === undefined) return undefined;
      const desc = await this.titleService.generateWorkDescription({
        client: this.client,
        repoDir: this.repoDir,
        contextText: text,
        ...(branchHint !== undefined ? { branchHint } : {}),
        ...(this.titleGenConfig !== undefined ? { config: this.titleGenConfig } : {}),
        ...(stepModel !== undefined ? { sessionProviderID: stepModel.providerID } : {}),
        ...(this.sessionMetadata !== undefined
          ? { sessionMetadata: { ...this.sessionMetadata, purpose: "title", parentSessionID: sessionID } }
          : {}),
        signal: this.controller.signal,
        log: this.log,
      });
      if (desc !== undefined && !this.applied) {
        this.applied = true;
        this.appliedToSessionID = sessionID;
        try {
          await this.applyTitle(desc, sessionID);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`[looper] title gen: applyTitle threw: ${message}`);
        }
      }
      return desc;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[looper] title gen snapshot threw: ${message}`);
      return undefined;
    }
  }
}
