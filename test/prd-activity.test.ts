import { afterEach, describe, expect, test } from "bun:test";
import { summarizeActivity, summarizeAgentActivity, toolActivity, type ActivityContext } from "../src/core/agent-activity.ts";
import type { LooperEvent } from "../src/core/events.ts";
import { constellationAgents } from "../src/presentation/tui/constellation.ts";
import { childActivitySummary, stepActivitySummary } from "../src/presentation/tui/agent-activity.ts";
import { cancelPendingNotify } from "../src/lib/state.ts";
import { constellationFixture } from "./fixtures/constellation-state.ts";

afterEach(cancelPendingNotify);
const context: ActivityContext = { repoDir: "/repo", prdDir: "/repo/spec/config-translation" };
const path = (name: string) => "spec/config-translation/" + name;
const read = (filePath: string, config = context) => toolActivity("read", { filePath }, config);

// Names reflect the two sample PRDs; fixtures need neither user files nor tool output.
const roles = [
  ["prd.json", "Reviewing the PRD task list", "Updating the PRD task list", "Reviewing PRD task list changes"],
  ["progress.txt", "Reviewing agent handoff notes", "Recording progress, issues, and handoff notes", "Reviewing progress and handoff updates"],
  ["prd-config-translation-01-stories.md", "Reviewing user stories and acceptance criteria", "Updating user stories and acceptance criteria", "Reviewing user story changes"],
  ["US-609E0-recipe-init.md", "Reviewing user stories and acceptance criteria", "Updating user stories and acceptance criteria", "Reviewing user story changes"],
  ["prd-config-translation-00-index.md", "Reviewing the PRD plan and dependencies", "Updating the PRD plan and dependencies", "Reviewing PRD plan changes"],
  ["spec-config-translation.md", "Reviewing the PRD technical specification", "Updating the PRD technical specification", "Reviewing PRD specification changes"],
  ["lando3-gap-analysis.md", "Reviewing PRD references and design notes", "Updating PRD references and design notes", "Reviewing PRD supporting material changes"],
  ["reference/kitchen-sink.lando.yml", "Reviewing PRD references and design notes", "Updating PRD references and design notes", "Reviewing PRD supporting material changes"],
  ["check-coordinated-plan.mjs", "Reviewing PRD references and design notes", "Updating PRD references and design notes", "Reviewing PRD supporting material changes"],
];

describe("configured PRD activity", () => {
  test.each(roles)("describes reads and changes to %s by purpose", (file, reviewing, updating, done) => {
    for (const tool of ["read", "read_file"]) {
      expect(toolActivity(tool, { filePath: path(file!) }, context)).toBe(reviewing!);
      expect(summarizeActivity([{ kind: "tool.done", tool, input: { file_path: path(file!) }, output: "private" }], context)).toBe(reviewing!);
    }
    for (const tool of ["edit", "write", "multiedit"]) {
      expect(toolActivity(tool, { filePath: path(file!) }, context)).toBe(updating!);
      expect(summarizeActivity([{ kind: "tool.done", tool, input: { path: path(file!) }, output: "private" }], context)).toBe(done!);
    }
    expect(toolActivity("apply_patch", { patchText: "*** Begin Patch\n*** Update File: " + path(file!) + "\n+x\n*** End Patch" }, context)).toBe(updating!);
  });

  test("normalizes paths and matches only the configured directory", () => {
    for (const file of [path("prd.json"), "/repo/" + path("prd.json"), "./spec/config-translation/reference/../prd.json"]) {
      expect(read(file)).toBe("Reviewing the PRD task list");
    }
    expect(read(path("prd.json"), { repoDir: "/repo", prdDir: "spec/config-translation" })).toBe("Reviewing the PRD task list");
    for (const file of ["prd.json", "spec/lando3-compat/prd.json", "spec/config-translation-old/prd.json", path("../prd.json"), path("../../src/prd.json")]) {
      expect(read(file)).toBe("Reading prd.json");
    }
    expect(toolActivity("read", { filePath: path("prd.json") })).toBe("Reading prd.json");
    expect(read(path("prd.json"), { repoDir: "/repo" })).toBe("Reading prd.json");
    expect(read(path("reference/prd.json"))).toBe("Reviewing PRD references and design notes");
    expect(read(path("reference/progress.txt"))).toBe("Reviewing PRD references and design notes");
    expect(read("/shared/PRD/prd.json", { repoDir: "/repo", prdDir: "/shared/PRD" })).toBe("Reviewing the PRD task list");
    expect(read("C:\\repo\\spec\\prd.json", { repoDir: "C:\\repo", prdDir: "spec" })).toBe("Reviewing the PRD task list");
    expect(read("C:/repo/spec/../src/prd.json", { repoDir: "C:\\repo", prdDir: "spec" })).toBe("Reading prd.json");
  });

  test("the lando3 layout uses the same rules without hardcoding a PRD name", () => {
    const other = { repoDir: "/repo", prdDir: "spec/lando3-compat" };
    expect(read("spec/lando3-compat/prd-lando3-compat-01-stories.md", other)).toBe("Reviewing user stories and acceptance criteria");
    expect(read("spec/lando3-compat/spec-lando3-compat.md", other)).toBe("Reviewing the PRD technical specification");
    expect(read("spec/lando3-compat/reference/kitchen-sink.config.yml", other)).toBe("Reviewing PRD references and design notes");
  });

  test("mixed patches retain implementation scope and same-role patches use purpose", () => {
    const patch = (files: string[]) => ({ patch: "*** Begin Patch\n" + files.map(file => "*** Update File: " + file + "\n+x").join("\n") + "\n*** End Patch" });
    expect(toolActivity("apply_patch", patch([path("prd.json"), "src/index.ts"]), context)).toBe("Patching 2 files");
    expect(toolActivity("apply_patch", patch([path("prd.json"), path("progress.txt")]), context)).toBe("Updating the PRD and supporting material");
    expect(toolActivity("apply_patch", patch([path("user-stories.md"), path("US-609E1.md")]), context)).toBe("Updating user stories and acceptance criteria");
    expect(toolActivity("multiedit", { edits: [{ filePath: path("prd.json") }, { file_path: path("progress.txt") }] }, context)).toBe("Updating the PRD and supporting material");
    expect(toolActivity("apply_patch", { patch: "*** Delete File: " + path("prd.json") }, context)).toBe("Removing the PRD task list");
    expect(toolActivity("apply_patch", { patch: "*** Update File: " + path("prd.json") + "\n*** Move to: src/prd.json" }, context)).toBe("Editing prd.json");
  });

  test("failures are not presented as reading or updating successfully", () => {
    expect(summarizeActivity([{ kind: "tool.failed", tool: "read", input: { filePath: path("prd.json") }, error: "private" }], context)).toBe("Could not read the PRD task list");
    expect(summarizeActivity([{ kind: "tool.failed", tool: "edit", input: { filePath: path("progress.txt") }, error: "private" }], context)).toBe("Could not update agent handoff notes");
  });
});

describe("PRD shell operations", () => {
  const cases = [
    ["cat spec/config-translation/prd.json", "Reviewing the PRD task list"],
    ["jq '.userStories[] | select(.passes == false)' spec/config-translation/prd.json", "Reviewing the PRD task list"],
    ["jq --arg id 'US-609E0' -e '.userStories[] | select(.id == $id)' spec/config-translation/prd.json", "Reviewing the PRD task list"],
    ["cat spec/config-translation/prd.json | jq '.userStories'", "Reviewing the PRD task list"],
    ["sed -n '1,80p' spec/config-translation/prd.json", "Reviewing the PRD task list"],
    ["cd /repo/spec/config-translation && tail -n 80 progress.txt", "Reviewing agent handoff notes"],
    ["head -40 spec/config-translation/progress.txt", "Reviewing agent handoff notes"],
    ["rg -n 'US-609E0' spec/config-translation/prd.json", "Reviewing the PRD task list"],
    ["grep -n 'issues' spec/config-translation/progress.txt", "Reviewing agent handoff notes"],
    ["cat <<'EOF' >> spec/config-translation/progress.txt\nprogress notes\nEOF", "Recording progress, issues, and handoff notes"],
    ["printf '%s\\n' 'notes' >> spec/config-translation/progress.txt", "Recording progress, issues, and handoff notes"],
    ["echo notes | tee -a spec/config-translation/progress.txt", "Recording progress, issues, and handoff notes"],
    ["sed -i 's/false/true/' spec/config-translation/prd.json", "Updating the PRD task list"],
    ["mv /tmp/updated.json spec/config-translation/prd.json", "Updating the PRD task list"],
    ["cat < spec/config-translation/prd.json", "Reviewing the PRD task list"],
  ];
  test.each(cases)("recognizes %s", (command, expected) => {
    expect(toolActivity("bash", { command, description: "generic tool description" }, context)).toBe(expected!);
  });

  test("supports explicit working directories and quoted paths", () => {
    expect(toolActivity("exec_command", { cmd: "cat prd.json", workdir: "/repo/spec/config-translation" }, context)).toBe("Reviewing the PRD task list");
    expect(toolActivity("bash", { command: "cd '/repo/spec/my PRD' && cat 'prd.json'" }, { repoDir: "/repo", prdDir: "spec/my PRD" })).toBe("Reviewing the PRD task list");
  });

  test("ignores filenames in prose, script bodies, tests, and unrecognized commands", () => {
    for (const command of [
      "echo 'cat spec/config-translation/prd.json'",
      "python3 -c 'print(\"spec/config-translation/prd.json\")'",
      "cat <<'EOF'\ncat spec/config-translation/prd.json\nEOF",
      "echo spec/config-translation/prd.json",
      "echo '>' spec/config-translation/prd.json",
      "echo $(cat spec/config-translation/prd.json)",
      "bun spec/config-translation/check-coordinated-plan.mjs",
      "cat $PRD_DIR/prd.json",
      "cat spec/config-translation/prd.json src/index.ts",
      "cd $SOMEWHERE && cat spec/config-translation/prd.json",
    ]) expect(toolActivity("bash", { command, description: "Original command description" }, context)).toBe("Original command description");
    expect(toolActivity("bash", { command: "bun test spec/config-translation/prd.test.ts" }, context)).toBe("Testing prd.test.ts");
    expect(toolActivity("bash", { command: "cat spec/config-translation/prd.json && bun run test:unit" }, context)).toBe("Running unit tests");
  });
});

test("context reaches parents, children, and overview without contaminating another run's cache", () => {
  const state = constellationFixture();
  state.activityContext = context;
  const event: LooperEvent = { kind: "tool.started", tool: "read", input: { filePath: path("prd.json") } };
  const step = state.steps[1]!;
  step.outputEvents = [event];
  const child = step.backgroundAgents[0]!;
  child.outputEvents = [event];
  delete child.activitySummary;
  for (let i = 0; i < 10; i++) {
    expect(summarizeActivity([event])).toBe("Reading prd.json");
    expect(summarizeActivity([event], context)).toBe("Reviewing the PRD task list");
    expect(stepActivitySummary(step, undefined, context)).toBe("Reviewing the PRD task list");
    expect(childActivitySummary(child, undefined, 1, context)).toBe("Reviewing the PRD task list");
    const nodes = constellationAgents(state);
    expect(nodes.find(node => node.id === "step:1")?.summary).toBe("Reviewing the PRD task list");
    expect(nodes.find(node => node.sessionID === child.sessionID)?.summary).toBe("Reviewing the PRD task list");
  }
  const different = { repoDir: "/repo", prdDir: "spec/another" };
  expect(summarizeAgentActivity(step, [event], different)).toBe("Reading prd.json");
  expect(summarizeAgentActivity(step, [event], context)).toBe("Reviewing the PRD task list");
});
