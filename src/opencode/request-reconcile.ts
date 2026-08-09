import type { OpencodeClient, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";

import type { RequestBroker } from "./request-broker.ts";
import { formatRequestError, toError } from "./util.ts";

type ReconcileOpenRequestsOptions = {
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly broker: RequestBroker;
  readonly pushLine: (line: string) => void;
};

export async function reconcileOpenRequests(options: ReconcileOpenRequestsOptions): Promise<void> {
  let permissions: readonly PermissionRequest[] | undefined;
  let questions: readonly QuestionRequest[] | undefined;
  try {
    const result = await options.client.permission.list({ directory: options.repoDir });
    if (result.error !== undefined) options.pushLine(`[looper] permission.list failed during reconcile: ${formatRequestError(result.error)}`);
    else permissions = result.data ?? [];
  } catch (error) {
    options.pushLine(`[looper] permission.list failed during reconcile: ${toError(error).message}`);
  }
  try {
    const result = await options.client.question.list({ directory: options.repoDir });
    if (result.error !== undefined) options.pushLine(`[looper] question.list failed during reconcile: ${formatRequestError(result.error)}`);
    else questions = result.data ?? [];
  } catch (error) {
    options.pushLine(`[looper] question.list failed during reconcile: ${toError(error).message}`);
  }
  options.broker.reconcile({
    ...(permissions !== undefined ? { permissions } : {}),
    ...(questions !== undefined ? { questions } : {}),
  });
}
