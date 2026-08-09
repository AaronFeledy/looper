import type { LoopState } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";

/** ASCII BEL: audible/visual alert, no cursor movement, safe to interleave with the renderer. */
export const BELL = "\u0007";

export type PermissionBellOptions = {
  readonly enabled: boolean;
  readonly isTTY: boolean;
  readonly write: (text: string) => void;
};

/** Request ids waiting on a human that have not been announced yet. */
export function unannouncedRequestIDs(state: LoopState, announced: ReadonlySet<string>): string[] {
  return state.pendingRequests.filter(({ status, requestID }) => status !== "resolving" && !announced.has(requestID)).map(({ requestID }) => requestID);
}

/**
 * Rings the terminal bell once per batch of newly gated requests, so an operator
 * away from the terminal learns the run is waiting on them. Returns a detach fn.
 */
export function createPermissionBell(state: LoopState, options: PermissionBellOptions): () => void {
  if (!options.enabled || !options.isTTY) return () => {};

  const announced = new Set<string>();
  return subscribe(() => {
    const queued = new Set(state.pendingRequests.map(({ requestID }) => requestID));
    // Forget resolved ids so the same request id asked again still alerts.
    for (const requestID of announced) if (!queued.has(requestID)) announced.delete(requestID);

    const fresh = unannouncedRequestIDs(state, announced);
    if (fresh.length === 0) return;
    for (const requestID of fresh) announced.add(requestID);
    options.write(BELL);
  });
}
