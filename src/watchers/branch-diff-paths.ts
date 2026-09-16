import { resolve } from "node:path";
import { PRD_INDEX_FILENAME, PRD_PROGRESS_FILENAME } from "../lib/prd.ts";

/** Exclude the configured PRD bookkeeping files, preserving same-named files elsewhere. */
export function includeBranchDiffPath(repoDir: string, prdDir?: string): (file?: string) => boolean {
  const excluded = new Set(prdDir === undefined ? [] :
    [PRD_PROGRESS_FILENAME, PRD_INDEX_FILENAME].map(name => resolve(repoDir, prdDir, name)));
  return file => file === undefined || !excluded.has(resolve(repoDir, file));
}
