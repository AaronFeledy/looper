import { notify, setBranchDiffStatus, setGithubStatus, setPrdStatus, type LoopState } from "../lib/state.ts";
import type { WatcherEvent } from "../watchers/watcher-events.ts";

function assertNever(event: never): never {
  throw new Error(`unhandled watcher event: ${JSON.stringify(event)}`);
}

export function createWatcherEventHandler(opts: {
  readonly state: LoopState;
  readonly refreshGithub: () => void;
  readonly refreshBranchDiff: () => void;
}): (event: WatcherEvent) => void {
  return (event) => {
    switch (event.kind) {
      case "branch-change":
        if (opts.state.branch === event.branch) return;
        opts.state.branch = event.branch;
        notify();
        opts.refreshGithub();
        opts.refreshBranchDiff();
        return;
      case "github-status":
        setGithubStatus(opts.state, event.status);
        return;
      case "prd-status":
        setPrdStatus(opts.state, event.status);
        return;
      case "branch-diff":
        setBranchDiffStatus(opts.state, event.status);
        return;
      default:
        return assertNever(event);
    }
  };
}
