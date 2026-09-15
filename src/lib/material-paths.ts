import { relative } from "node:path";

/**
 * Paths that count as material progress: everything outside the configured PRD
 * directory. PRD-dir churn (progress.txt, prd.json edits) is deliberately
 * excluded so docs-only loops cannot reset stall counters or satisfy the
 * `implemented` signal precondition. A missing/empty/`..` prdRel means every
 * path is material (no exclusion).
 */
export function filterMaterialPaths(paths: readonly string[], prdRel: string | undefined): string[] {
  if (prdRel === undefined || prdRel === "" || prdRel.startsWith("..")) return [...paths];
  const prefix = prdRel.endsWith("/") ? prdRel : `${prdRel}/`;
  return paths.filter((path) => path !== prdRel && !path.startsWith(prefix));
}

export function materialPathsExist(paths: readonly string[], prdRel: string | undefined): boolean {
  return filterMaterialPaths(paths, prdRel).length > 0;
}

/**
 * Repo-relative form of `prdDir` for material-path filtering. Returns
 * `undefined` when no PRD dir is configured. Callers pass the result as
 * `prdRel` to {@link filterMaterialPaths} / {@link materialPathsExist}.
 */
export function prdDirRelative(repoDir: string, prdDir: string | undefined): string | undefined {
  if (prdDir === undefined) return undefined;
  return relative(repoDir, prdDir).replaceAll("\\", "/");
}
