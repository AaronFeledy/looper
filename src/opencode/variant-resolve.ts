import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import type { VariantConfig } from "../lib/config.ts";
import { formatRequestError, toError } from "./util.ts";

/** Opencode sentinel that clears agent-default / reasoning-level variants. */
export const OPENCODE_DEFAULT_VARIANT = "default";

export type ResolvedModel = {
  readonly providerID: string;
  readonly modelID: string;
};

export type ResolvePromptVariantInput = {
  readonly client: OpencodeClient;
  readonly repoDir: string;
  readonly model: ResolvedModel | undefined;
  readonly variant: VariantConfig | undefined;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
};

/** Config variant → session.prompt variant (`null` → `"default"`; unsupported names dropped). */
export async function resolvePromptVariant(input: ResolvePromptVariantInput): Promise<string | undefined> {
  const { variant } = input;
  if (variant === undefined || variant === "") return undefined;
  if (variant === null) return OPENCODE_DEFAULT_VARIANT;

  const supported = await modelVariantNames(input);
  if (supported === undefined) return variant;
  if (supported.has(variant)) return variant;

  input.log?.(
    `[looper] model ${formatModel(input.model)} does not support variant=${variant}; omitting (available: ${formatAvailable(supported)})`,
  );
  return undefined;
}

function formatModel(model: ResolvedModel | undefined): string {
  if (model === undefined) return "(unspecified)";
  return `${model.providerID}/${model.modelID}`;
}

function formatAvailable(names: ReadonlySet<string>): string {
  if (names.size === 0) return "none";
  return [...names].sort().join(", ");
}

async function modelVariantNames(input: ResolvePromptVariantInput): Promise<ReadonlySet<string> | undefined> {
  const { model, client, repoDir, signal, log } = input;
  if (model === undefined) return undefined;
  try {
    const result = await client.provider.list({ directory: repoDir }, { signal });
    if (result.error || !result.data) {
      log?.(`[looper] provider.list failed while checking variants: ${formatRequestError(result.error)}`);
      return undefined;
    }
    const providers = result.data.all;
    const provider = providers.find((entry) => entry.id === model.providerID);
    // Absent provider/model means the listing is incomplete (custom or
    // dynamically registered models), not that variants are unsupported:
    // fail open and let opencode decide, same as a provider.list error.
    if (provider === undefined) return undefined;
    const entry =
      provider.models[model.modelID] ??
      Object.values(provider.models).find((candidate) => candidate.id === model.modelID);
    if (entry === undefined) return undefined;
    const variants = entry.variants;
    if (variants === undefined) return new Set();
    return new Set(Object.keys(variants));
  } catch (error) {
    log?.(`[looper] provider.list threw while checking variants: ${toError(error).message}`);
    return undefined;
  }
}
