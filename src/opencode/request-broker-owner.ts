import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import type { PermissionPolicy, QuestionPolicy } from "../lib/config.ts";
import type { LoopState } from "../lib/state.ts";
import { OwnedSessionSet } from "../lib/owned-session-set.ts";
import { DEFAULT_STEP_TIMEOUT_MS, permissionGateMaxMs, permissionTeardownMs } from "../config/tunables.ts";
import { createRequestBroker, type RequestBroker, type RequestFrictionState } from "./request-broker.ts";
import { reconcileOpenRequests } from "./request-reconcile.ts";
import { teardownRequests, type TeardownClock, type TeardownResult } from "./request-teardown.ts";
import type { Step } from "./step-runner-types.ts";

type RequestBrokerOwnerOptions = {
  readonly state: LoopState;
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly step: Step;
  readonly pushLine: (line: string) => void;
  readonly unattended: boolean;
  readonly friction: RequestFrictionState;
  readonly writeStop?: (reason: string) => void;
  readonly permissionPolicy?: PermissionPolicy;
  readonly questionPolicy?: QuestionPolicy;
  readonly onHumanGateChange?: (open: boolean) => void;
  readonly gateMaxMs?: number;
  readonly teardownMs?: number;
  readonly teardownClock?: TeardownClock;
};

export class UnsafeBrokerReplacementError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "UnsafeBrokerReplacementError";
  }
}

export type BoundRequestBroker = {
  readonly broker: RequestBroker;
  readonly ownedSessions: OwnedSessionSet;
};

export type RequestBrokerOwner = {
  readonly bind: (sessionID: string) => BoundRequestBroker;
  readonly reconcile: () => Promise<void>;
  readonly teardown: (sessionID: string, timeoutMs?: number) => Promise<TeardownResult>;
  readonly dispose: () => void;
  readonly subscribeHumanGate: (listener: (open: boolean) => void) => () => void;
  readonly owns: (sessionID: string) => boolean;
};

export function createRequestBrokerOwner(options: RequestBrokerOwnerOptions): RequestBrokerOwner {
  let activeSessionID: string | undefined;
  let bound: BoundRequestBroker | undefined;
  let replacementBlockedReason: string | undefined;
  const humanGateListeners = new Set<(open: boolean) => void>();
  if (options.onHumanGateChange !== undefined) humanGateListeners.add(options.onHumanGateChange);
  const gateMaxMs = options.gateMaxMs ?? permissionGateMaxMs();
  const stepTimeoutMs = options.step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  if (gateMaxMs >= stepTimeoutMs) options.pushLine(`[looper] permission gate maximum ${gateMaxMs}ms is not shorter than step timeout ${stepTimeoutMs}ms`);

  return {
    bind(sessionID) {
      if (replacementBlockedReason !== undefined && activeSessionID !== sessionID) throw new UnsafeBrokerReplacementError(replacementBlockedReason);
      if (bound !== undefined && activeSessionID === sessionID) return bound;
      bound?.broker.clearUI();
      bound?.broker.dispose();
      const ownedSessions = new OwnedSessionSet(sessionID);
      const broker = createRequestBroker({
        state: options.state,
        client: options.client,
        repoDir: options.repoDir,
        step: options.step,
        activeSessionID: sessionID,
        ownedSessionIDs: () => ownedSessions.ids(),
        pushLine: options.pushLine,
        unattended: options.unattended,
        friction: options.friction,
        ...(options.writeStop !== undefined ? { writeStop: options.writeStop } : {}),
        gateMaxMs,
        ...(options.permissionPolicy !== undefined ? { permissionPolicy: options.permissionPolicy } : {}),
        ...(options.questionPolicy !== undefined ? { questionPolicy: options.questionPolicy } : {}),
        onHumanGateChange: (open) => {
          for (const listener of humanGateListeners) listener(open);
        },
      });
      activeSessionID = sessionID;
      bound = { broker, ownedSessions };
      return bound;
    },
    async reconcile() {
      if (bound === undefined) return;
      await reconcileOpenRequests({ client: options.client, repoDir: options.repoDir, broker: bound.broker, pushLine: options.pushLine });
    },
    async teardown(sessionID, timeoutMs) {
      if (bound === undefined || activeSessionID !== sessionID) return { safeToProceed: false, reason: `permission teardown has no broker for session ${sessionID}` };
      const result = await teardownRequests({
        client: options.client,
        repoDir: options.repoDir,
        sessionID,
        broker: bound.broker,
        timeoutMs: Math.min(options.teardownMs ?? permissionTeardownMs(), timeoutMs ?? Number.POSITIVE_INFINITY),
        pushLine: options.pushLine,
        ...(options.teardownClock !== undefined ? { clock: options.teardownClock } : {}),
      });
      if (!result.safeToProceed) replacementBlockedReason = result.reason;
      return result;
    },
    dispose() {
      bound?.broker.clearUI();
      bound?.broker.dispose();
      bound = undefined;
      activeSessionID = undefined;
    },
    subscribeHumanGate(listener) {
      humanGateListeners.add(listener);
      return () => humanGateListeners.delete(listener);
    },
    owns(sessionID) {
      return bound !== undefined && activeSessionID === sessionID;
    },
  };
}
