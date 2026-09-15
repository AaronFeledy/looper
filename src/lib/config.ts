import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { DEFAULT_STEP_TIMEOUT_MS } from "../config/tunables.ts";
import { STORY_PHASE_ORDER, comparePhase, isValidPhase, type StoryPhase } from "./story-state-files.ts";

export type PermissionAction = "always" | "once" | "reject" | "ask";

export type PermissionPolicy = Record<string, PermissionAction>;

export type QuestionPolicy = "ask" | "reject";

// Keys of the `<looper-context>` prompt-injection block (see prompt-context.ts),
// each individually toggleable via `context:` config. Kept in sync manually;
// this list IS the config-side source of truth for valid keys.
export const CONTEXT_KEYS = ["datetime", "repoDir", "loopPosition", "timebox", "vcsDelta", "sessionIds", "prd", "story"] as const;
export type ContextKey = (typeof CONTEXT_KEYS)[number];
export type ContextPolicy = Record<ContextKey, boolean>;
type ContextPolicyOverride = Partial<ContextPolicy>;

/** `string` = named variant; `null` = force-disable; omit = agent/opencode default. */
export type VariantConfig = string | null;

export type GateConfig = {
  readonly branch?: "story" | "main";
  readonly phase?: StoryPhase;
  readonly phaseBelow?: StoryPhase;
  readonly script?: string;
};

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
  gate?: GateConfig;
  /** Required outcome phase signal for the step (requires top-level `prd:`). */
  expects?: StoryPhase;
  setsPhase?: StoryPhase;
};

export const DEFAULT_TERMINAL_PHASE: StoryPhase = "merged";
export const DEFAULT_MAIN_BRANCH = "main";

const PRD_PASSES_DEPRECATION =
  'gate.prdPasses is deprecated; use gate.phase: implemented instead (prdPasses was accepted as an alias)';

/** Soft warnings collected during the active config-load call. Cleared at begin; snapshotted onto RuntimeConfig. */
let configLoadWarnings: string[] = [];

function noteConfigWarning(message: string): void {
  if (!configLoadWarnings.includes(message)) configLoadWarnings.push(message);
}

function beginConfigLoad(): void {
  configLoadWarnings = [];
}

function finishConfigLoadWarnings(): readonly string[] {
  const out = configLoadWarnings;
  configLoadWarnings = [];
  return Object.freeze(out.slice()) as readonly string[];
}

// Config file name candidates, in resolution order. `.yml` is preferred over
// `.yaml`; dot-prefixed variants are last-resort fallbacks.
export const CONFIG_FILE_NAMES = ["looper.yml", "looper.yaml", ".looper.yml", ".looper.yaml"] as const;
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
  gate?: unknown;
  expects?: unknown;
  setsPhase?: unknown;
};

type RawConfig = {
  adjudicate?: unknown;
  opencode?: unknown;
  attachUrl?: unknown;
  timeout?: unknown;
  recovery?: unknown;
  steps?: unknown;
  permissionPolicy?: unknown;
  questionPolicy?: unknown;
  useSessionIdle?: unknown;
  validateResources?: unknown;
  context?: unknown;
  prd?: unknown;
  prdFlipThreshold?: unknown;
  storyIdPattern?: unknown;
  terminalPhase?: unknown;
  mainBranch?: unknown;
  stall?: unknown;
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
  prdFlipThreshold?: number;
  storyIdPattern?: string;
  /** Phase at or past which a story is considered complete for termination/selection. Default: merged. */
  terminalPhase: StoryPhase;
  /** Mainline branch name used for derived merged checks. Default: main. */
  mainBranch: string;
  stall?: StallConfig;
  useSessionIdle: boolean;
  validateResources: boolean;
  /** Soft load-time warnings (deprecations, etc.). Empty when the config is clean. */
  warnings: readonly string[];
};

export type StallConfig = {
  iterations?: number;
  adjudications?: number;
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

function storyPhaseValue(value: unknown, label: string): StoryPhase {
  if (typeof value !== "string" || !isValidPhase(value)) {
    throw new Error(`${label} must be one of: ${STORY_PHASE_ORDER.join(", ")}`);
  }
  return value;
}

function parseGateConfig(value: unknown, label: string): GateConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }

  let branch: GateConfig["branch"];
  let phase: StoryPhase | undefined;
  let phaseBelow: StoryPhase | undefined;
  let script: string | undefined;
  let sawPrdPasses = false;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    switch (key) {
      case "branch":
        if (entry !== "story" && entry !== "main") {
          throw new Error(`${label}.branch must be "story" or "main"`);
        }
        branch = entry;
        break;
      case "prdPasses":
        // Back-compat alias of phase: implemented. Never stored on the loaded gate.
        if (entry !== true) throw new Error(`${label}.prdPasses must be true`);
        sawPrdPasses = true;
        break;
      case "phase":
        phase = storyPhaseValue(entry, `${label}.phase`);
        break;
      case "phaseBelow":
        phaseBelow = storyPhaseValue(entry, `${label}.phaseBelow`);
        break;
      case "script":
        if (typeof entry !== "string") throw new Error(`${label}.script must be a string`);
        if (entry.length === 0) throw new Error(`${label}.script cannot be empty`);
        script = entry;
        break;
      default:
        throw new Error(
          `${label}.${key} is not a valid gate key (valid keys: branch, prdPasses, phase, phaseBelow, script)`,
        );
    }
  }

  if (sawPrdPasses) {
    noteConfigWarning(PRD_PASSES_DEPRECATION);
    // Explicit phase wins; prdPasses only supplies the default when phase is absent.
    if (phase === undefined) phase = "implemented";
  }

  if (branch === undefined && phase === undefined && phaseBelow === undefined && script === undefined) return undefined;
  return {
    ...(branch !== undefined ? { branch } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(phaseBelow !== undefined ? { phaseBelow } : {}),
    ...(script !== undefined ? { script } : {}),
  };
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
  const stepWildcard = step.permissionPolicy?.["*"];
  if (stepWildcard !== undefined) return stepWildcard;
  const globalKind = global.permissionPolicy?.[kind];
  if (globalKind !== undefined) return globalKind;
  const wildcard = global.permissionPolicy?.["*"];
  if (wildcard !== undefined) return wildcard;
  return "ask";
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  datetime: true,
  repoDir: true,
  loopPosition: true,
  timebox: true,
  vcsDelta: true,
  sessionIds: true,
  prd: true,
  story: true,
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

type ConfiguredStepInput = {
  configDir: string;
  rawStep: unknown;
  label: string;
  defaultName: string;
  rootTimeoutMs: number;
};

function parseConfiguredStep(input: ConfiguredStepInput): LoadedStep {
  if (!input.rawStep || typeof input.rawStep !== "object" || Array.isArray(input.rawStep)) {
    throw new Error(`${input.label} must be a mapping`);
  }
  const rawStep = input.rawStep as RawStep;
  const expects = rawStep.expects === undefined ? undefined : storyPhaseValue(rawStep.expects, `${input.label}.expects`);
  const setsPhase = rawStep.setsPhase === undefined ? undefined : storyPhaseValue(rawStep.setsPhase, `${input.label}.setsPhase`);
  if (expects !== undefined && setsPhase !== undefined && comparePhase(setsPhase, expects) > 0) {
    // setsPhase is applied after the outcome contract is satisfied; letting it
    // exceed `expects` would promote a story past what the step actually proved.
    throw new Error(`${input.label}.setsPhase (${setsPhase}) must not be later than ${input.label}.expects (${expects})`);
  }
  return {
    name: stringValue(rawStep.name, `${input.label}.name`, input.defaultName),
    agent: optionalNonEmptyStringValue(rawStep.agent, `${input.label}.agent`),
    model: optionalModelValue(rawStep.model, `${input.label}.model`),
    variant: optionalVariantValue(rawStep.variant, `${input.label}.variant`),
    prompt: promptPath(input.configDir, stringValue(rawStep.prompt, `${input.label}.prompt`), input.label),
    prefix: stringValue(rawStep.prefix, `${input.label}.prefix`) || undefined,
    suffix: stringValue(rawStep.suffix, `${input.label}.suffix`) || undefined,
    args: argsValue(rawStep.args, `${input.label}.args`),
    timeoutMs: rawStep.timeout === undefined || rawStep.timeout === null ? input.rootTimeoutMs : timeoutValue(rawStep.timeout, `${input.label}.timeout`),
    title: titleValue(rawStep.title, `${input.label}.title`),
    permissionPolicy: parsePermissionPolicy(rawStep.permissionPolicy, `${input.label}.permissionPolicy`),
    questionPolicy: parseQuestionPolicy(rawStep.questionPolicy, `${input.label}.questionPolicy`),
    contextPolicy: parseContextPolicy(rawStep.context, `${input.label}.context`),
    gate: parseGateConfig(rawStep.gate, `${input.label}.gate`),
    expects,
    setsPhase,
  };
}

function parseConfiguredSteps(configDir: string, rawConfig: RawConfig): LoadedStep[] {
  if (!rawConfig.steps || typeof rawConfig.steps !== "object" || Array.isArray(rawConfig.steps)) {
    throw new Error(`${CONFIG_FILE_NAME} must define a mapping at steps:`);
  }

  const rootTimeoutMs = timeoutValue(rawConfig.timeout, "timeout");

  return Object.entries(rawConfig.steps as Record<string, RawStep>).map(([key, rawStep]) =>
    parseConfiguredStep({ configDir, rawStep, label: `steps.${key}`, defaultName: titleFromKey(key), rootTimeoutMs }),
  );
}

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

export function findConfigFile(configDir: string): string | undefined {
  return configCandidatePaths(configDir).find((candidate) => isRegularFile(candidate));
}

export function configFilePath(configDir: string): string {
  return findConfigFile(configDir) ?? join(configDir, CONFIG_FILE_NAME);
}

export type ConfigFileSource = {
  path: string;
  content: string;
};

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function readConfigFileSource(configDir: string): ConfigFileSource | undefined {
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

// Bun.YAML last-wins on duplicate keys (npm yaml threw). Looper configs do not use duplicate keys.
// Unquoted dates remain strings for our fixtures (do not assume Date).
function loadRawConfig(configDir: string): RawConfig {
  const configFile = readConfigFileSource(configDir);
  if (configFile === undefined) {
    throw new Error(`missing ${CONFIG_FILE_NAME} in ${configDir} (looked for ${CONFIG_FILE_NAMES.join(", ")}); create it with at least one step`);
  }

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(configFile.content);
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

function optionalPositiveIntegerValue(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be an integer >= 1`);
  }
  return value;
}

function optionalNonNegativeIntegerValue(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be an integer >= 0`);
  }
  return value;
}

function parseStallConfig(value: unknown, label: string): StallConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILE_NAME}.${label} must be a mapping`);
  }
  const raw = value as { iterations?: unknown; adjudications?: unknown };
  const iterations = optionalNonNegativeIntegerValue(raw.iterations, `${label}.iterations`);
  const adjudications = optionalNonNegativeIntegerValue(raw.adjudications, `${label}.adjudications`);
  return {
    ...(iterations !== undefined ? { iterations } : {}),
    ...(adjudications !== undefined ? { adjudications } : {}),
  };
}

function stepRequiresPrd(step: LoadedStep): boolean {
  return step.gate?.phase !== undefined || step.gate?.phaseBelow !== undefined || step.expects !== undefined;
}

function describePrdRequirement(step: LoadedStep): string {
  const parts: string[] = [];
  if (step.gate?.phase !== undefined) parts.push("gate.phase");
  if (step.gate?.phaseBelow !== undefined) parts.push("gate.phaseBelow");
  if (step.expects !== undefined) parts.push("expects");
  return parts.join(", ");
}

export function loadRuntimeConfig(configDir: string, repoDir: string = process.cwd()): RuntimeConfig {
  beginConfigLoad();
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
  // Always parse regular + adjudicate steps so gate.prdPasses deprecation warnings are
  // collected even when prd: is present (the requires-prd check only runs when absent).
  const rootTimeoutMs = timeoutValue(rawConfig.timeout, "timeout");
  const adjudicateStep =
    rawConfig.adjudicate === undefined
      ? undefined
      : parseConfiguredStep({ configDir, rawStep: rawConfig.adjudicate, label: "adjudicate", defaultName: "adjudicate", rootTimeoutMs });
  const configuredSteps = parseConfiguredSteps(configDir, rawConfig);
  if (prdDir === undefined) {
    const stepRequiringPrd = [...configuredSteps, ...(adjudicateStep === undefined ? [] : [adjudicateStep])].find(
      (step) => stepRequiresPrd(step),
    );
    if (stepRequiringPrd !== undefined) {
      throw new Error(
        `${stepRequiringPrd.name} requires top-level prd: when using ${describePrdRequirement(stepRequiringPrd)}`,
      );
    }
  }
  const prdFlipThreshold = optionalPositiveIntegerValue(rawConfig.prdFlipThreshold, "prdFlipThreshold");
  const storyIdPattern = optionalNonEmptyStringValue(rawConfig.storyIdPattern, "storyIdPattern");
  const terminalPhase =
    rawConfig.terminalPhase === undefined
      ? DEFAULT_TERMINAL_PHASE
      : storyPhaseValue(rawConfig.terminalPhase, "terminalPhase");
  const mainBranchParsed = optionalNonEmptyStringValue(rawConfig.mainBranch, "mainBranch");
  const mainBranch = mainBranchParsed ?? DEFAULT_MAIN_BRANCH;
  const stall = parseStallConfig(rawConfig.stall, "stall");
  const warnings = finishConfigLoadWarnings();
  return {
    ...(opencodeServerUrl !== undefined ? { opencodeServerUrl } : {}),
    ...(title !== undefined ? { title } : {}),
    recovery,
    ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
    ...(questionPolicy !== undefined ? { questionPolicy } : {}),
    ...(contextPolicy !== undefined ? { contextPolicy } : {}),
    ...(prdDir !== undefined ? { prdDir } : {}),
    ...(prdFlipThreshold !== undefined ? { prdFlipThreshold } : {}),
    ...(storyIdPattern !== undefined ? { storyIdPattern } : {}),
    terminalPhase,
    mainBranch,
    ...(stall !== undefined ? { stall } : {}),
    useSessionIdle: booleanFlagValue(rawConfig.useSessionIdle, "useSessionIdle", false),
    validateResources: booleanFlagValue(rawConfig.validateResources, "validateResources", false),
    warnings,
  };
}

export function assertPromptFilesExist(steps: readonly LoadedStep[]): void {
  const missing = steps.filter((step) => !isRegularFile(step.prompt));
  if (missing.length === 0) return;
  const lines = missing.map((step) => `  ${step.name}: ${step.prompt}`);
  throw new Error(`missing prompt file${missing.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
}

export function loadSteps(configDir: string): LoadedStep[] {
  beginConfigLoad();
  try {
    const rawConfig = loadRawConfig(configDir);
    const steps = parseConfiguredSteps(configDir, rawConfig);
    if (steps.length === 0) throw new Error(`${CONFIG_FILE_NAME} must define at least one step`);
    return steps;
  } finally {
    // Warnings for deprecations live on RuntimeConfig via loadRuntimeConfig; discard
    // any collected during the steps-only load so module state never leaks across calls.
    finishConfigLoadWarnings();
  }
}

export function loadAdjudicateStep(configDir: string): LoadedStep | undefined {
  beginConfigLoad();
  try {
    const rawConfig = loadRawConfig(configDir);
    if (rawConfig.adjudicate === undefined) return undefined;
    return parseConfiguredStep({
      configDir,
      rawStep: rawConfig.adjudicate,
      label: "adjudicate",
      defaultName: "adjudicate",
      rootTimeoutMs: timeoutValue(rawConfig.timeout, "timeout"),
    });
  } finally {
    finishConfigLoadWarnings();
  }
}
