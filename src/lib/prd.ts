import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PRD_INDEX_FILENAME = "prd.json";

export type PrdResult =
  | { readonly kind: "ok"; readonly remaining: number; readonly total: number }
  | { readonly kind: "error"; readonly message: string };

export function prdIndexPath(prdDir: string): string {
  return join(prdDir, PRD_INDEX_FILENAME);
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function countPrd(raw: string): PrdResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "error", message: "invalid JSON" };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed["userStories"])) {
    return { kind: "error", message: "missing userStories" };
  }

  const userStories: readonly unknown[] = parsed["userStories"];
  const total = userStories.length;
  let remaining = 0;
  for (const story of userStories) {
    if (!isRecord(story) || story["passes"] !== true) remaining += 1;
  }

  return { kind: "ok", remaining, total };
}

export function readPrd(prdDir: string): PrdResult {
  try {
    return countPrd(readFileSync(prdIndexPath(prdDir), "utf8"));
  } catch (error) {
    if (isMissingPath(error)) return { kind: "error", message: "prd.json not found" };
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "error", message };
  }
}
