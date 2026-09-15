import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_FILE_NAME, findConfigFile } from "./config.ts";

export type ScaffoldResult =
  | { readonly kind: "created"; readonly configPath: string; readonly files: readonly string[] }
  | { readonly kind: "already-initialized"; readonly configPath: string };

function configTemplate(): string {
  return `# Looper drives OpenCode through these steps, in order, on a loop,
# until every configured PRD story reaches terminalPhase (or max_iterations hits).
# Prompt paths are relative to this directory. Run \`looper --help\` for flags.

# timeout: 60m                    # default per-step timeout
# opencode:
#   serverUrl: http://127.0.0.1:4096  # attach to a running server instead of spawning one

# Point prd: at a directory containing prd.json ({ userStories: [{ id, title, priority, dependsOn }] })
# to enable story tracking. Steps then report progress with \`looper signal story-phase <phase>\`,
# and the run stops on its own once every story reaches terminalPhase.
# prd: spec/prd
# terminalPhase: merged           # building < implemented < reviewed < verified < published < merged
# mainBranch: main

steps:
  work:
    name: Work
    prompt: work.md
    # agent: build                # opencode agent (optional)
    # model: openai/gpt-5.5       # provider/model (optional)
    # variant: high               # reasoning variant (optional; null disables)
    # timeout: 45m
    # gate:                       # with prd: configured, skip when the story is already implemented
    #   phaseBelow: implemented
    # expects: implemented        # with prd: configured, the step must end with an outcome signal
`;
}

function workTemplate(): string {
  return `Pick the highest-priority unfinished piece of work in this repository and complete it.

Replace this prompt with your real instructions: what to build, how to verify it,
and what "done" means for a single iteration. Keep each iteration small enough to
finish in one sitting; the loop will run again.

If this config has \`prd:\` set, work the story named under \`next:\` in the looper
context block, and end your turn with exactly one signal:
\`looper signal story-phase implemented\` once the work is committed,
\`looper signal blocked --reason "<what stopped you>"\` if you could not finish, or
\`looper signal no-op --reason "<why>"\` if there was nothing to do.
`;
}

function gitignoreTemplate(): string {
  return [
    "# Machine-local SQLite mutex. Recreates on the next locked write; never commit it.",
    ".looper-state-lock.sqlite",
    ".looper-state-lock.sqlite-*",
    "",
  ].join("\n");
}

export function scaffoldConfigDir({ configDir }: { configDir: string; repoDir: string }): ScaffoldResult {
  const existing = findConfigFile(configDir);
  if (existing !== undefined) return { kind: "already-initialized", configPath: existing };

  mkdirSync(configDir, { recursive: true });
  const files: string[] = [];

  const configPath = join(configDir, CONFIG_FILE_NAME);
  writeFileSync(configPath, configTemplate());
  files.push(configPath);

  const gitignorePath = join(configDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, gitignoreTemplate());
    files.push(gitignorePath);
  }

  for (const [name, content] of [["work.md", workTemplate()]] as const) {
    const path = join(configDir, name);
    if (existsSync(path)) continue;
    writeFileSync(path, content);
    files.push(path);
  }

  return { kind: "created", configPath, files };
}
