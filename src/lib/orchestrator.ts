export {
  FALLBACK_BASE_BRANCHES,
  MAINLINE_BRANCH_NAMES,
  isMainlineRef,
  commitsAheadOfRef,
  normalizeGitStatusCode,
  parseNumstatZ,
  parseNameStatusZ,
  branchDeltaChangedFiles,
  resolveBranchDelta,
  fetchBranchDelta,
  fetchPromptVcsDelta,
} from "../watchers/branch-delta.ts";
export { promptText, runIteration, StepFailureError } from "../engine/run-iteration.ts";
export type { BranchDelta, BranchDeltaChange } from "../watchers/branch-delta.ts";
export type { ResumeSession, RunIterationHooks, RunIterationOptions } from "../engine/run-iteration.ts";
