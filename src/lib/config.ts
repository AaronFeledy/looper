import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";

import { DEFAULT_STEP_TIMEOUT_MS } from "../config/tunables.ts";

export type PermissionAction = "always" | "once" | "reject" | "ask";

export type PermissionPolicy = Record<string, PermissionAction>;

export type QuestionPolicy = "ask" | "reject";

// Keys of the `<looper-context>` prompt-injection block (see prompt-context.ts),
// each individually toggleable via `context:` config. Kept in sync manually;
// this list IS the config-side source of truth for valid keys.
export const CONTEXT_KEYS = ["datetime", "repoDir", "loopPosition", "timebox", "vcsDelta", "sessionIds", "prd"] as const;
export type ContextKey = (typeof CONTEXT_KEYS)[number];
export type ContextPolicy = Record<ContextKey, boolean>;
type ContextPolicyOverride = Partial<ContextPolicy>;

/** `string` = named variant; `null` = force-disable; omit = agent/opencode default. */
export type VariantConfig = string | null;

export type LoadedStep = {
  name: string;
  agent?: string;
  variant?: VariantConfig;
  model?: string;
  prompt: string;
  prefix?: string;
  suffix?: string;
  args?: string[];
  timeoutMs?: number;
  title?: boolean | number | "branch";
  permissionPolicy?: PermissionPolicy;
  questionPolicy?: QuestionPolicy;
  contextPolicy?: ContextPolicyOverride;
};

// Config file name candidates, in resolution order. `.yml` is preferred over
// `.yaml`; dot-prefixed variants are last-resort fallbacks.
export const CONFIG_FILE_NAMES = ["looper.yml", "looper.yaml", ".looper.yml", ".looper.yaml"] as const;
// Preferred / default file name, used in messages and when creating a config.
export const CONFIG_FILE_NAME = CONFIG_FILE_NAMES[0];

type RawStep = {
  name?: unknown;
  agent?: unknown;
  model?: unknown;
  variant?: unknown;
  prompt?: unknown;
  prefix?: unknown;
  suffix?: unknown;
  args?: unknown;
  title?: unknown;
  timeout?: unknown;
  permissionPolicy?: unknown;
  questionPolicy?: unknown;
  context?: unknown;
};

type RawConfig = {
  opencode?: unknown;
  attachUrl?: unknown;
  timeout?: unknown;
  recovery?: unknown;
  steps?: unknown;
  permissionPolicy?: unknown;
  questionPolicy?: unknown;
  useSessionIdle?: unknown;
  vcsSummary?: unknown;
  validateResources?: unknown;
  context?: unknown;
  prd?: unknown;
};

export type RecoverySnapshotsConfig = false | "before-retry" | "before-retry-and-skip";

/**
 * Optional overrides for the throwaway session that generates step titles.
 * Title generation runs against opencode's default agent unless overridden
 * here under `opencode.title:`. When `model` is unset, looper reproduces
 * opencode's own title-model resolution: `small_model` if set, else a
 * cheap-model heuristic scoped to the step's provider (see
 * `resolveDefaultTitleModel` in title.ts), else opencode's default `model`.
 * Set `model` here to force a specific model regardless.
 */
export type TitleGenConfig = {
  agent?: string;
  model?: string;
  variant?: VariantConfig;
};

export type RuntimeConfig = {
  opencodeServerUrl?: string;
  title?: TitleGenConfig;
  recovery: {
    snapshots: RecoverySnapshotsConfig;
  };
  permissionPolicy?: PermissionPolicy;
  questionPolicy?: QuestionPolicy;
  contextPolicy?: ContextPolicyOverride;
  prdDir?: string;
  useSessionIdle: boolean;
  vcsSummary: boolean;
  validateResources: boolean;
};

function titleFromKey(key: string): string {
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function stringValue(value: unknown, label: string, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function argsValue(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function titleValue(value: unknown, label: string): boolean | number | "branch" | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "branch") return "branch";
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${label} must be true, false, "branch", or an integer >= 1 (seconds)`);
    }
    return value;
  }
  throw new Error(`${label} must be true, false, "branch", or an integer >= 1 (seconds)`);
}

function timeoutValue(value: unknown, label: string): number {
  if (value === undefined || value === null) return DEFAULT_STEP_TIMEOUT_MS;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be an integer >= 1 (minutes) or a duration string like "60m", "1h", or "30s"`);
    return value * 60 * 1000;
  }
  if (typeof value !== "string") throw new Error(`${label} must be an integer >= 1 (minutes) or a duration string like "60m", "1h", or "30s"`);
  const match = value.trim().match(/^(\d+)(s|m|h)$/i);
  if (!match) throw new Error(`${label} must be an integer >= 1 (minutes) or a duration string like "60m", "1h", or "30s"`);
  const amount = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(amount) || amount < 1) throw new Error(`${label} must be an integer >= 1 (minutes) or a duration string like "60m", "1h", or "30s"`);
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === "s" ? 1000 : unit === "m" ? 60 * 1000 : 60 * 60 * 1000;
  return amount * multiplier;
}

const PERMISSION_ACTIONS: readonly PermissionAction[] = ["always", "once", "reject", "ask"];

function permissionActionValue(value: unknown, label: string): PermissionAction {
  if (typeof value !== "string" || !PERMISSION_ACTIONS.includes(value as PermissionAction)) {
    throw new Error(`${label} must be one of: always, once, reject, ask`);
  }
  return value as PermissionAction;
}

function parsePermissionPolicy(value: unknown, label: string): PermissionPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  const out: PermissionPolicy = {};
  for (const [kind, action] of Object.entries(value as Record<string, unknown>)) {
    out[kind] = permissionActionValue(action, `${label}.${kind}`);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function parseContextPolicy(value: unknown, label: string): ContextPolicyOverride | undefined {
  if (value === undefined || value === null || value === true) return undefined;
  if (value === false) {
    return Object.fromEntries(CONTEXT_KEYS.map((key) => [key, false])) as ContextPolicyOverride;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a boolean or a mapping of ${CONTEXT_KEYS.join(", ")} to booleans`);
  }
  const out: ContextPolicyOverride = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!CONTEXT_KEYS.includes(key as ContextKey)) {
      throw new Error(`${label}.${key} is not a valid context key (valid keys: ${CONTEXT_KEYS.join(", ")})`);
    }
    if (typeof entry !== "boolean") throw new Error(`${label}.${key} must be a boolean`);
    out[key as ContextKey] = entry;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function parseQuestionPolicy(value: unknown, label: string): QuestionPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "ask" || value === "reject") return value;
  throw new Error(`${label} must be "ask" or "reject"`);
}

function booleanFlagValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

// "always"|"once"|"reject" match opencode client.permission.reply; "ask" = no auto-reply.
export function resolvePermissionAction(
  kind: string,
  step: Pick<LoadedStep, "permissionPolicy">,
  global: Pick<RuntimeConfig, "permissionPolicy">,
): PermissionAction {
  const stepAction = step.permissionPolicy?.[kind];
  if (stepAction !== undefined) return stepAction;
  const globalKind = global.permissionPolicy?.[kind];
  if (globalKind !== undefined) return globalKind;
  const wildcard = global.permissionPolicy?.["*"];
  if (wildcard !== undefined) return wildcard;
  return "ask";
}

const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  datetime: true,
  repoDir: true,
  loopPosition: true,
  timebox: true,
  vcsDelta: true,
  sessionIds: true,
  prd: true,
};

export function resolveContextPolicy(
  step: Pick<LoadedStep, "contextPolicy">,
  global: Pick<RuntimeConfig, "contextPolicy">,
): ContextPolicy {
  const resolved = { ...DEFAULT_CONTEXT_POLICY };
  for (const key of CONTEXT_KEYS) {
    const stepOverride = step.contextPolicy?.[key];
    if (stepOverride !== undefined) {
      resolved[key] = stepOverride;
      continue;
    }
    const globalOverride = global.contextPolicy?.[key];
    if (globalOverride !== undefined) resolved[key] = globalOverride;
  }
  return resolved;
}

function optionalNonEmptyStringValue(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = stringValue(value, label);
  if (parsed.length === 0) throw new Error(`${label} cannot be empty`);
  return parsed;
}

/**
 * `provider/model` id, e.g. "openai/gpt-5.5". Format is enforced here because
 * a malformed model (no provider separator) would otherwise be dropped
 * silently at prompt time and opencode would fall back to its default —
 * usually a far more expensive — agent/model.
 */
function optionalModelValue(value: unknown, label: string): string | undefined {
  const parsed = optionalNonEmptyStringValue(value, label);
  if (parsed === undefined) return undefined;
  const slash = parsed.indexOf("/");
  if (slash <= 0 || slash === parsed.length - 1) {
    throw new Error(`${label} must be "provider/model" (e.g. "openai/gpt-5.5"); got "${parsed}"`);
  }
  return parsed;
}

function optionalVariantValue(value: unknown, label: string): VariantConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = stringValue(value, label);
  if (parsed.length === 0) throw new Error(`${label} cannot be empty (use null to disable)`);
  return parsed;
}

function promptPath(configDir: string, prompt: string, label: string): string {
  if (!prompt) throw new Error(`${label}.prompt is required`);
  return isAbsolute(prompt) ? prompt : resolve(configDir, prompt);
}

function parseConfiguredSteps(configDir: string, rawConfig: RawConfig): LoadedStep[] {
  if (!rawConfig.steps || typeof rawConfig.steps !== "object" || Array.isArray(rawConfig.steps)) {
    throw new Error(`${CONFIG_FILE_NAME} must define a mapping at steps:`);
  }

  const rootTimeoutMs = timeoutValue(rawConfig.timeout, "timeout");

  return Object.entries(rawConfig.steps as Record<string, RawStep>).map(([key, rawStep]) => {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      throw new Error(`steps.${key} must be a mapping`);
    }

    return {
      name: stringValue(rawStep.name, `steps.${key}.name`, titleFromKey(key)),
      agent: optionalNonEmptyStringValue(rawStep.agent, `steps.${key}.agent`),
      model: optionalModelValue(rawStep.model, `steps.${key}.model`),
      variant: optionalVariantValue(rawStep.variant, `steps.${key}.variant`),
      prompt: promptPath(configDir, stringValue(rawStep.prompt, `steps.${key}.prompt`), `steps.${key}`),
      prefix: stringValue(rawStep.prefix, `steps.${key}.prefix`) || undefined,
      suffix: stringValue(rawStep.suffix, `steps.${key}.suffix`) || undefined,
      args: argsValue(rawStep.args, `steps.${key}.args`),
      timeoutMs: rawStep.timeout === undefined || rawStep.timeout === null ? rootTimeoutMs : timeoutValue(rawStep.timeout, `steps.${key}.timeout`),
      title: titleValue(rawStep.title, `steps.${key}.title`),
      permissionPolicy: parsePermissionPolicy(rawStep.permissionPolicy, `steps.${key}.permissionPolicy`),
      questionPolicy: parseQuestionPolicy(rawStep.questionPolicy, `steps.${key}.questionPolicy`),
      contextPolicy: parseContextPolicy(rawStep.context, `steps.${key}.context`),
    };
  });
}

/** Absolute paths of every candidate config file in `configDir`, in resolution order. */
export function configCandidatePaths(configDir: string): string[] {
  return CONFIG_FILE_NAMES.map((name) => join(configDir, name));
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** First existing config file in `configDir`, or undefined if none exist. */
export function findConfigFile(configDir: string): string | undefined {
  return configCandidatePaths(configDir).find((candidate) => isRegularFile(candidate));
}

/** Resolved existing config path, or the default (preferred) path when none exist. */
export function configFilePath(configDir: string): string {
  return findConfigFile(configDir) ?? join(configDir, CONFIG_FILE_NAME);
}

type ConfigFileRead = {
  path: string;
  content: string;
};

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function readFirstConfigFile(configDir: string): ConfigFileRead | undefined {
  for (const configPath of configCandidatePaths(configDir)) {
    if (!isRegularFile(configPath)) continue;
    try {
      return { path: configPath, content: readFileSync(configPath, "utf8") };
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
  }
  return undefined;
}

function loadRawConfig(configDir: string): RawConfig {
  const configFile = readFirstConfigFile(configDir);
  if (configFile === undefined) {
    throw new Error(`missing ${CONFIG_FILE_NAME} in ${configDir} (looked for ${CONFIG_FILE_NAMES.join(", ")}); create it with at least one step`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(configFile.content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${configFile.path} is not valid YAML: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configFile.path} must contain a mapping`);
  }
  return parsed as RawConfig;
}

function parseTitleConfig(value: unknown): TitleGenConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILE_NAME}.opencode.title must be a mapping`);
  }
  const raw = value as { agent?: unknown; model?: unknown; variant?: unknown };
  const agent = optionalNonEmptyStringValue(raw.agent, "opencode.title.agent");
  const model = optionalModelValue(raw.model, "opencode.title.model");
  const variant = optionalVariantValue(raw.variant, "opencode.title.variant");
  if (agent === undefined && model === undefined && variant === undefined) return undefined;
  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
}

function parseRecoverySnapshots(value: unknown): RecoverySnapshotsConfig {
  if (value === undefined || value === null) return false;
  if (value === false) return false;
  if (value === "before-retry" || value === "before-retry-and-skip") return value;
  throw new Error(`${CONFIG_FILE_NAME}.recovery.snapshots must be false, "before-retry", or "before-retry-and-skip"`);
}

function parseRecoveryConfig(value: unknown): RuntimeConfig["recovery"] {
  if (value === undefined || value === null) return { snapshots: false };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILE_NAME}.recovery must be a mapping`);
  }
  const raw = value as { snapshots?: unknown };
  return { snapshots: parseRecoverySnapshots(raw.snapshots) };
}

export function loadRuntimeConfig(configDir: string, repoDir: string = process.cwd()): RuntimeConfig {
  const rawConfig = loadRawConfig(configDir);
  let opencodeServerUrl: string | undefined;
  let title: TitleGenConfig | undefined;
  if (rawConfig.opencode !== undefined) {
    if (!rawConfig.opencode || typeof rawConfig.opencode !== "object" || Array.isArray(rawConfig.opencode)) {
      throw new Error(`${CONFIG_FILE_NAME}.opencode must be a mapping`);
    }
    const opencode = rawConfig.opencode as { serverUrl?: unknown; title?: unknown };
    opencodeServerUrl = optionalNonEmptyStringValue(opencode.serverUrl, "opencode.serverUrl");
    title = parseTitleConfig(opencode.title);
  }
  opencodeServerUrl ??= optionalNonEmptyStringValue(rawConfig.attachUrl, "attachUrl");
  const recovery = parseRecoveryConfig(rawConfig.recovery);
  const permissionPolicy = parsePermissionPolicy(rawConfig.permissionPolicy, "permissionPolicy");
  const questionPolicy = parseQuestionPolicy(rawConfig.questionPolicy, "questionPolicy");
  const contextPolicy = parseContextPolicy(rawConfig.context, "context");
  const prdRaw = optionalNonEmptyStringValue(rawConfig.prd, "prd");
  const prdDir = prdRaw === undefined ? undefined : isAbsolute(prdRaw) ? prdRaw : resolve(repoDir, prdRaw);
  return {
    ...(opencodeServerUrl !== undefined ? { opencodeServerUrl } : {}),
    ...(title !== undefined ? { title } : {}),
    recovery,
    ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
    ...(questionPolicy !== undefined ? { questionPolicy } : {}),
    ...(contextPolicy !== undefined ? { contextPolicy } : {}),
    ...(prdDir !== undefined ? { prdDir } : {}),
    useSessionIdle: booleanFlagValue(rawConfig.useSessionIdle, "useSessionIdle", false),
    vcsSummary: booleanFlagValue(rawConfig.vcsSummary, "vcsSummary", false),
    validateResources: booleanFlagValue(rawConfig.validateResources, "validateResources", false),
  };
}

export function assertPromptFilesExist(steps: readonly LoadedStep[]): void {
  const missing = steps.filter((step) => !isRegularFile(step.prompt));
  if (missing.length === 0) return;
  const lines = missing.map((step) => `  ${step.name}: ${step.prompt}`);
  throw new Error(`missing prompt file${missing.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
}

export function loadSteps(configDir: string): LoadedStep[] {
  const rawConfig = loadRawConfig(configDir);
  const steps = parseConfiguredSteps(configDir, rawConfig);
  if (steps.length === 0) throw new Error(`${CONFIG_FILE_NAME} must define at least one step`);
  return steps;
}
