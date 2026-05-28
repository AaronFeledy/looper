import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";

import type { Step } from "./runner.ts";

export const CONFIG_FILE_NAME = "looper.yaml";

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
};

type RawConfig = {
  opencode?: unknown;
  attachUrl?: unknown;
  steps?: unknown;
};

export type RuntimeConfig = {
  opencodeServerUrl?: string;
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
      title: titleValue(rawStep.title, `steps.${key}.title`),
    };
  });
}

export function configFilePath(configDir: string): string {
  return join(configDir, CONFIG_FILE_NAME);
}

function loadRawConfig(configDir: string): RawConfig {
  const configPath = configFilePath(configDir);
  if (!existsSync(configPath)) {
    throw new Error(`missing ${CONFIG_FILE_NAME} at ${configPath}; create it with at least one step`);
  }

  const rawConfig = YAML.parse(readFileSync(configPath, "utf8")) as RawConfig | null;
  if (!rawConfig || typeof rawConfig !== "object") throw new Error(`${CONFIG_FILE_NAME} must contain a mapping`);
  return rawConfig;
}

export function loadRuntimeConfig(configDir: string): RuntimeConfig {
  const rawConfig = loadRawConfig(configDir);
  let opencodeServerUrl: string | undefined;
  if (rawConfig.opencode !== undefined) {
    if (!rawConfig.opencode || typeof rawConfig.opencode !== "object" || Array.isArray(rawConfig.opencode)) {
      throw new Error(`${CONFIG_FILE_NAME}.opencode must be a mapping`);
    }
    const opencode = rawConfig.opencode as { serverUrl?: unknown };
    opencodeServerUrl = optionalNonEmptyStringValue(opencode.serverUrl, "opencode.serverUrl");
  }
  opencodeServerUrl ??= optionalNonEmptyStringValue(rawConfig.attachUrl, "attachUrl");
  return { opencodeServerUrl };
}

export function loadSteps(configDir: string): Step[] {
  const rawConfig = loadRawConfig(configDir);
  const steps = parseConfiguredSteps(configDir, rawConfig);
  if (steps.length === 0) throw new Error(`${CONFIG_FILE_NAME} must define at least one step`);
  return steps;
}
