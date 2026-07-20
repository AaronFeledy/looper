export const DEFAULT_STEP_TIMEOUT_MS = 60 * 60 * 1000;

export function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CONTINUATION_EXIT_GRACE_MS = positiveIntegerEnv("LOOPER_CONTINUATION_EXIT_GRACE_MS", 30_000);
export const EVENT_WATCHDOG_POLL_MS = positiveIntegerEnv("LOOPER_EVENT_WATCHDOG_POLL_MS", 15_000);
export const EVENT_STALL_THRESHOLD_MS = positiveIntegerEnv("LOOPER_EVENT_STALL_MS", 45_000);
export const EVENT_RESUBSCRIBE_BACKOFF_MS = positiveIntegerEnv("LOOPER_EVENT_RESUBSCRIBE_BACKOFF_MS", 1_000);
export const STOP_SESSION_CONFIRM_POLL_MS = positiveIntegerEnv("LOOPER_STOP_SESSION_POLL_MS", 250);

const STOP_SESSION_CONFIRM_TIMEOUT_MS = 10_000;
const SERVER_RECOVERY_DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;
const SERVER_RECOVERY_DEFAULT_BACKOFF_BASE_MS = 2_000;
const SERVER_RECOVERY_DEFAULT_BACKOFF_MAX_MS = 30_000;
const SERVER_RECOVERY_DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const TITLE_GEN_TIMEOUT_MS_DEFAULT = 60_000;
const BRANCH_DIFF_COLLECTION_TIMEOUT_MS_DEFAULT = 10_000;
export const DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS = 10_000;

export function staleBusyResumeThresholdMs(): number {
  return positiveIntegerEnv("LOOPER_STALE_BUSY_RESUME_MS", DEFAULT_STEP_TIMEOUT_MS);
}

export function prdFlipThreshold(configValue?: number): number {
  // Precedence: environment override, then looper.yaml, then the built-in default.
  return positiveIntegerEnv("LOOPER_PRD_FLIP_THRESHOLD", configValue ?? 2);
}

export function stopSessionConfirmTimeoutMs(): number {
  return positiveIntegerEnv("LOOPER_STOP_SESSION_TIMEOUT_MS", STOP_SESSION_CONFIRM_TIMEOUT_MS);
}

export function serverRecoveryMaxWaitMs(): number {
  return positiveIntegerEnv("LOOPER_SERVER_RECOVERY_MAX_WAIT_MS", SERVER_RECOVERY_DEFAULT_MAX_WAIT_MS);
}

export function serverRecoveryBackoffBaseMs(): number {
  return positiveIntegerEnv("LOOPER_SERVER_RECOVERY_BACKOFF_BASE_MS", SERVER_RECOVERY_DEFAULT_BACKOFF_BASE_MS);
}

export function serverRecoveryBackoffMaxMs(): number {
  return positiveIntegerEnv("LOOPER_SERVER_RECOVERY_BACKOFF_MAX_MS", SERVER_RECOVERY_DEFAULT_BACKOFF_MAX_MS);
}

export function serverRecoveryProbeTimeoutMs(): number {
  return positiveIntegerEnv("LOOPER_SERVER_RECOVERY_PROBE_TIMEOUT_MS", SERVER_RECOVERY_DEFAULT_PROBE_TIMEOUT_MS);
}

export function promptVcsTimeoutMs(): number {
  const raw = Number(process.env["LOOPER_PROMPT_VCS_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

export function branchDiffCollectionTimeoutMs(): number {
  return positiveIntegerEnv("LOOPER_BRANCH_DIFF_TIMEOUT_MS", BRANCH_DIFF_COLLECTION_TIMEOUT_MS_DEFAULT);
}

export function inheritedRenameDelayMs(): number {
  const raw = Number(process.env["LOOPER_INHERITED_TITLE_DELAY_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

export function titleGenTimeoutMs(): number {
  const raw = Number(process.env["LOOPER_TITLE_GEN_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : TITLE_GEN_TIMEOUT_MS_DEFAULT;
}

export function configuredAttachValidationTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs !== undefined) return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS;
  const raw = process.env["LOOPER_ATTACH_VALIDATION_TIMEOUT_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS;
}
