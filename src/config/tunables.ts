export const DEFAULT_STEP_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_PERMISSION_GATE_MAX_MS = 1_800_000;
export const DEFAULT_PERMISSION_TEARDOWN_MS = 5_000;

export function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be an integer greater than or equal to 1`);
  return parsed;
}

const FALSE_ENV_VALUES = new Set(["0", "false", "off", "no"]);

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return !FALSE_ENV_VALUES.has(value);
}

export function permissionBellEnabled(): boolean {
  // Terminal bell when a request starts waiting on a human. On by default; the TUI only writes it on a TTY.
  return booleanEnv("LOOPER_PERMISSION_BELL", true);
}

export function permissionGateMaxMs(): number {
  return requiredPositiveIntegerEnv("LOOPER_PERMISSION_GATE_MAX_MS", DEFAULT_PERMISSION_GATE_MAX_MS);
}

export function permissionTeardownMs(): number {
  return requiredPositiveIntegerEnv("LOOPER_PERMISSION_TEARDOWN_MS", DEFAULT_PERMISSION_TEARDOWN_MS);
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
const GATE_SCRIPT_TIMEOUT_MS_DEFAULT = 30_000;
export const DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS = 10_000;

export function staleBusyResumeThresholdMs(): number {
  return positiveIntegerEnv("LOOPER_STALE_BUSY_RESUME_MS", DEFAULT_STEP_TIMEOUT_MS);
}

export function prdFlipThreshold(configValue?: number): number {
  // Precedence: environment override, then looper.yaml, then the built-in default.
  return positiveIntegerEnv("LOOPER_PRD_FLIP_THRESHOLD", configValue ?? 2);
}

export function nonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const STALL_ITERATION_LIMIT_DEFAULT = 3;
const STALL_ADJUDICATION_LIMIT_DEFAULT = 3;
const STALL_CONFIRM_MS_DEFAULT = 180_000;

export function stallIterationLimit(configValue?: number): number {
  // Precedence: environment override, then looper.yaml stall.iterations, then the default. 0 disables.
  return nonNegativeIntegerEnv("LOOPER_STALL_ITERATIONS", configValue ?? STALL_ITERATION_LIMIT_DEFAULT);
}

export function stallAdjudicationLimit(configValue?: number): number {
  // Precedence: environment override, then looper.yaml stall.adjudications, then the default. 0 disables.
  return nonNegativeIntegerEnv("LOOPER_STALL_ADJUDICATIONS", configValue ?? STALL_ADJUDICATION_LIMIT_DEFAULT);
}

export function stallConfirmMs(): number {
  // Settle window between a stalled verdict and the confirming re-sample. 0 re-samples immediately.
  return nonNegativeIntegerEnv("LOOPER_STALL_CONFIRM_MS", STALL_CONFIRM_MS_DEFAULT);
}

const EMPTY_ASSISTANT_GRACE_MS_DEFAULT = 10_000;
const EMPTY_ASSISTANT_GRACE_POLL_MS_DEFAULT = 500;

export function emptyAssistantGraceMs(): number {
  // Bounded wait before an `empty` assistant classification becomes a step failure. 0 disables the wait.
  return nonNegativeIntegerEnv("LOOPER_EMPTY_ASSISTANT_GRACE_MS", EMPTY_ASSISTANT_GRACE_MS_DEFAULT);
}

export function emptyAssistantGracePollMs(): number {
  return positiveIntegerEnv("LOOPER_EMPTY_ASSISTANT_GRACE_POLL_MS", EMPTY_ASSISTANT_GRACE_POLL_MS_DEFAULT);
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

export function gateScriptTimeoutMs(): number {
  return positiveIntegerEnv("LOOPER_GATE_SCRIPT_TIMEOUT_MS", GATE_SCRIPT_TIMEOUT_MS_DEFAULT);
}

export function inheritedRenameDelayMs(): number {
  const raw = Number(process.env["LOOPER_INHERITED_TITLE_DELAY_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

export function titleGenTimeoutMs(): number {
  const raw = Number(process.env["LOOPER_TITLE_GEN_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : TITLE_GEN_TIMEOUT_MS_DEFAULT;
}

const FAILURE_RETRY_BASE_MS_DEFAULT = 15_000;
const FAILURE_RETRY_MAX_DELAY_MS_DEFAULT = 300_000;
const FAILURE_RETRY_MIN_REMAINING_MS_DEFAULT = 5_000;
const FAILURE_RETRY_JITTER_DEFAULT = 0.2;

export function failureRetryBaseMs(): number {
  return positiveIntegerEnv("LOOPER_FAILURE_RETRY_BASE_MS", FAILURE_RETRY_BASE_MS_DEFAULT);
}

export function failureRetryMaxDelayMs(): number {
  return positiveIntegerEnv("LOOPER_FAILURE_RETRY_MAX_DELAY_MS", FAILURE_RETRY_MAX_DELAY_MS_DEFAULT);
}

export function failureRetryMinRemainingMs(): number {
  return nonNegativeIntegerEnv("LOOPER_FAILURE_RETRY_MIN_REMAINING_MS", FAILURE_RETRY_MIN_REMAINING_MS_DEFAULT);
}

export function failureRetryJitterRatio(): number {
  const value = process.env["LOOPER_FAILURE_RETRY_JITTER"];
  if (value === undefined || value.trim() === "") return FAILURE_RETRY_JITTER_DEFAULT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return FAILURE_RETRY_JITTER_DEFAULT;
  return Math.min(1, parsed);
}

export function configuredAttachValidationTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs !== undefined) return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS;
  const raw = process.env["LOOPER_ATTACH_VALIDATION_TIMEOUT_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ATTACH_VALIDATION_TIMEOUT_MS;
}
