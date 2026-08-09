import { appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { tolerantRm } from "../lib/state-files.ts";

export const PERMISSION_AUDIT_FILE_NAME = ".looper-permission-log.jsonl";

export type PermissionAuditAction = "once" | "always" | "reject" | "skip";
export type PermissionAuditOrigin =
  | "human"
  | "policy"
  | "teardown"
  | "nontty_ask"
  | "gate_timeout"
  | "unattended_always_fail_closed";

export type PermissionAuditDecision = {
  readonly requestID: string;
  readonly sessionID: string;
  readonly kind: "permission" | "question";
  readonly permission?: string;
  readonly action: PermissionAuditAction;
  readonly origin: PermissionAuditOrigin;
  readonly stepIndex?: number;
};

export function appendPermissionAudit(
  configDir: string,
  decision: PermissionAuditDecision,
  onError: (message: string) => void,
): void {
  const path = join(configDir, PERMISSION_AUDIT_FILE_NAME);
  try {
    const record = { at: new Date().toISOString(), ...decision };
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onError(`[looper] permission audit write failed: ${message}`);
  }
}

export function clearPermissionAudit(configDir: string): void {
  tolerantRm(join(configDir, PERMISSION_AUDIT_FILE_NAME));
}
