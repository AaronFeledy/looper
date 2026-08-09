import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import type { RequestBroker } from "./request-broker.ts";
import { reconcileOpenRequests } from "./request-reconcile.ts";
import { isPendingSessionStatus } from "./session-health.ts";

export interface TeardownClock {
  sleep(milliseconds: number): Promise<void>;
}

export type TeardownResult = { readonly safeToProceed: true } | { readonly safeToProceed: false; readonly reason: string };

const systemClock: TeardownClock = { sleep: (milliseconds) => Bun.sleep(milliseconds) };

type TeardownOptions = {
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly sessionID: string;
  readonly broker: RequestBroker;
  readonly timeoutMs: number;
  readonly pushLine?: (line: string) => void;
  readonly clock?: TeardownClock;
};

const timeoutResult = (stage: string): TeardownResult => ({ safeToProceed: false, reason: `permission teardown timed out while ${stage}` });

export async function teardownRequests(options: TeardownOptions): Promise<TeardownResult> {
  const clock = options.clock ?? systemClock;
  const deadline = clock.sleep(options.timeoutMs).then(() => "timeout" as const);
  options.broker.stopAcceptingDecisions();
  const unsafe = (result: TeardownResult): TeardownResult => {
    options.broker.clearUI();
    return result;
  };

  const abortOutcome = await Promise.race([
    options.client.session.abort({ sessionID: options.sessionID, directory: options.repoDir }).then(
      () => "done" as const,
      () => "done" as const,
    ),
    deadline,
  ]);
  if (abortOutcome === "timeout") return unsafe(timeoutResult("aborting session"));

  const confirmStopped = async (): Promise<"done" | "unconfirmed"> => {
    while (true) {
      const outcome = await options.client.session.status({ directory: options.repoDir }).then(
        (result) => result.error === undefined && !isPendingSessionStatus(result.data?.[options.sessionID]) ? "done" as const : "pending" as const,
        () => "unconfirmed" as const,
      );
      if (outcome === "done" || outcome === "unconfirmed") return outcome;
      await clock.sleep(Math.min(100, options.timeoutMs));
    }
  };
  const statusOutcome = await Promise.race([confirmStopped(), deadline]);
  if (statusOutcome !== "done") return unsafe(statusOutcome === "timeout" ? timeoutResult("confirming session stop") : { safeToProceed: false, reason: "permission teardown could not confirm session stopped" });

  const reconcileOutcome = await Promise.race([
    reconcileOpenRequests({
      client: options.client,
      repoDir: options.repoDir,
      broker: options.broker,
      pushLine: options.pushLine ?? (() => undefined),
    }).then(() => "done" as const),
    deadline,
  ]);
  if (reconcileOutcome === "timeout") return unsafe(timeoutResult("reconciling requests"));

  const rejectOutcome = await Promise.race([options.broker.rejectOpen("session teardown").then(() => "done" as const), deadline]);
  const safeToProceed = rejectOutcome === "done" && !options.broker.hasOpenRequests();
  options.broker.clearUI();
  return safeToProceed ? { safeToProceed: true } : timeoutResult("rejecting open requests");
}
