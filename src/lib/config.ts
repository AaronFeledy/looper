import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";

import { DEFAULT_STEP_TIMEOUT_MS, type Step } from "./runner.ts";

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
};

type RawConfig = {
  opencode?: unknown;
  attachUrl?: unknown;
  timeout?: unknown;
  steps?: unknown;
};

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
  variant?: string;
};

export type RuntimeConfig = {
  opencodeServerUrl?: string;
  title?: TitleGenConfig;
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

function optionalNonEmptyStringValue(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = stringValue(value, label);
  if (parsed.length === 0) throw new Error(`${label} cannot be empty`);
  return parsed;
}

function promptPath(configDir: string, prompt: string, label: string): string {
  if (!prompt) throw new Error(`${label}.prompt is required`);
  return isAbsolute(prompt) ? prompt : resolve(configDir, prompt);
}

function parseConfiguredSteps(configDir: string, rawConfig: RawConfig): Step[] {
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
      model: optionalNonEmptyStringValue(rawStep.model, `steps.${key}.model`),
      variant: optionalNonEmptyStringValue(rawStep.variant, `steps.${key}.variant`),
      prompt: promptPath(configDir, stringValue(rawStep.prompt, `steps.${key}.prompt`), `steps.${key}`),
      prefix: stringValue(rawStep.prefix, `steps.${key}.prefix`) || undefined,
      suffix: stringValue(rawStep.suffix, `steps.${key}.suffix`) || undefined,
      args: argsValue(rawStep.args, `steps.${key}.args`),
      timeoutMs: rawStep.timeout === undefined || rawStep.timeout === null ? rootTimeoutMs : timeoutValue(rawStep.timeout, `steps.${key}.timeout`),
      title: titleValue(rawStep.title, `steps.${key}.title`),
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
  const model = optionalNonEmptyStringValue(raw.model, "opencode.title.model");
  const variant = optionalNonEmptyStringValue(raw.variant, "opencode.title.variant");
  if (agent === undefined && model === undefined && variant === undefined) return undefined;
  return {
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
}

export function loadRuntimeConfig(configDir: string): RuntimeConfig {
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
  return {
    ...(opencodeServerUrl !== undefined ? { opencodeServerUrl } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

export function loadSteps(configDir: string): Step[] {
  const rawConfig = loadRawConfig(configDir);
  const steps = parseConfiguredSteps(configDir, rawConfig);
  if (steps.length === 0) throw new Error(`${CONFIG_FILE_NAME} must define at least one step`);
  return steps;
}
