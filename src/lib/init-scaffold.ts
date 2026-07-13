import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { CONFIG_FILE_NAME, findConfigFile } from "./config.ts";

export type ScaffoldResult =
  | { readonly kind: "created"; readonly configPath: string; readonly files: readonly string[] }
  | { readonly kind: "already-initialized"; readonly configPath: string };

function configTemplate(): string {
  return `# Looper drives OpenCode through these steps, in order, on a loop,
# until a step creates .looper-stop in this directory (or max_iterations hits).
# Prompt paths are relative to this directory. Run \`looper --help\` for flags.

# timeout: 60m                    # default per-step timeout
# opencode:
#   serverUrl: http://127.0.0.1:4096  # attach to a running server instead of spawning one

steps:
  work:
    name: Work
    prompt: work.md
    # agent: build                # opencode agent (optional)
    # model: openai/gpt-5.5       # provider/model (optional)
    # variant: high               # reasoning variant (optional; null disables)
    # timeout: 45m

  check-done:
    name: Check Done
    prompt: check-done.md
    timeout: 5m
`;
}

function workTemplate(): string {
  return `Pick the highest-priority unfinished piece of work in this repository and complete it.

Replace this prompt with your real instructions: what to build, how to verify it,
and what "done" means for a single iteration. Keep each iteration small enough to
finish in one sitting; the loop will run again.
`;
}

function checkDoneTemplate(stopFileRelPath: string): string {
  return `Decide whether the overall goal of this loop is complete.

If there is still work remaining, do nothing and end your turn. Do not create or
modify any files.

If everything is done, create \`${stopFileRelPath}\` containing a one-line reason.
That file stops the loop.
`;
}

export function scaffoldConfigDir({ configDir, repoDir }: { configDir: string; repoDir: string }): ScaffoldResult {
  const existing = findConfigFile(configDir);
  if (existing !== undefined) return { kind: "already-initialized", configPath: existing };

  mkdirSync(configDir, { recursive: true });
  const stopFileRelPath = join(relative(repoDir, configDir) || ".", ".looper-stop");
  const files: string[] = [];

  const configPath = join(configDir, CONFIG_FILE_NAME);
  writeFileSync(configPath, configTemplate());
  files.push(configPath);

  for (const [name, content] of [
    ["work.md", workTemplate()],
    ["check-done.md", checkDoneTemplate(stopFileRelPath)],
  ] as const) {
    const path = join(configDir, name);
    if (existsSync(path)) continue;
    writeFileSync(path, content);
    files.push(path);
  }

  return { kind: "created", configPath, files };
}
