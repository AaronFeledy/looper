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
};

type RawConfig = {
  steps?: unknown;
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
      agent: stringValue(rawStep.agent, `steps.${key}.agent`, "sonny"),
      model: stringValue(rawStep.model, `steps.${key}.model`),
      variant: stringValue(rawStep.variant, `steps.${key}.variant`),
      prompt: promptPath(configDir, stringValue(rawStep.prompt, `steps.${key}.prompt`), `steps.${key}`),
      prefix: stringValue(rawStep.prefix, `steps.${key}.prefix`) || undefined,
      suffix: stringValue(rawStep.suffix, `steps.${key}.suffix`) || undefined,
      args: argsValue(rawStep.args, `steps.${key}.args`),
    };
  });
}

export function configFilePath(configDir: string): string {
  return join(configDir, CONFIG_FILE_NAME);
}

export function loadSteps(configDir: string): Step[] {
  const configPath = configFilePath(configDir);
  if (!existsSync(configPath)) {
    throw new Error(`missing ${CONFIG_FILE_NAME} at ${configPath}; create it with at least one step`);
  }

  const rawConfig = YAML.parse(readFileSync(configPath, "utf8")) as RawConfig | null;
  if (!rawConfig || typeof rawConfig !== "object") throw new Error(`${CONFIG_FILE_NAME} must contain a mapping`);

  const steps = parseConfiguredSteps(configDir, rawConfig);
  if (steps.length === 0) throw new Error(`${CONFIG_FILE_NAME} must define at least one step`);
  return steps;
}
