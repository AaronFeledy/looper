import { openUrl } from "../lib/open-url.ts";
import type { LoopState } from "../lib/state.ts";

export function tryOpenCurrentPr(state: LoopState): void {
  if (state.github.kind !== "pr") return;
  void openUrl(state.github.pr.url).catch(() => {});
}
