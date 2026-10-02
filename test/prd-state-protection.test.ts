import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preparePrdState } from "../src/lib/prd-state-protection.ts";
import { parseArgs } from "../src/lib/args.ts";
import { createRunStateStore } from "../src/persistence/run-state-store.ts";

let root: string;
let configDir: string;
let prdDir: string;
beforeEach(() => {
  const scratch = join(import.meta.dir, ".tmp"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "prd-state-"));
  configDir = join(root, "config");
  prdDir = join(root, "prd");
  mkdirSync(configDir); mkdirSync(prdDir);
  writeFileSync(join(prdDir, "prd.json"), '{"userStories":[{"id":"US-1"}]}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const statePath = () => join(configDir, ".looper-story-state.json");
const identityPath = () => join(configDir, ".looper-prd-identity.json");
const prepare = (extra: Partial<Parameters<typeof preparePrdState>[0]> = {}) => preparePrdState({
  configDir, repoDir: root, prdDir, fresh: false,
  stopSessions: async () => {}, confirmLegacyStopped: true, ...extra,
});

test("stamps normalized identity when no state exists", async () => {
  // Given an empty state directory; When startup prepares it.
  await prepare({ prdDir: join(prdDir, "..", "prd") });
  // Then identity is independent of a checkpoint.
  expect(JSON.parse(readFileSync(identityPath(), "utf8")).prdDir).toBe(prdDir);
  expect(existsSync(join(configDir, ".looper-run.json"))).toBe(false);
});

test("requires a decision when legacy state exists, even with fresh", async () => {
  // Given unassociated legacy state.
  writeFileSync(statePath(), "legacy");
  // When startup requests fresh; Then no implicit adoption or deletion.
  await expect(prepare({ fresh: true })).rejects.toThrow("--adopt-prd-state");
  expect(readFileSync(statePath(), "utf8")).toBe("legacy");
  expect(existsSync(identityPath())).toBe(false);
});

test("automatically archives all scoped state when the recorded PRD path changes", async () => {
  // Given associated state and protected non-state files.
  await prepare();
  const names = [".looper-story-state.json", ".looper-step-attempts.json", ".looper-phase-history.json", ".looper-adjudicate", ".looper-signals.jsonl", ".looper-permission-log.jsonl", ".last-branch"];
  for (const name of names) writeFileSync(join(configDir, name), name);
  writeFileSync(join(configDir, "looper.yml"), "config");
  writeFileSync(join(configDir, "work.md"), "prompt");
  const next = join(root, "next"); mkdirSync(next);
  writeFileSync(join(next, "prd.json"), '{"userStories":[{"id":"US-1"}]}');
  // When changing directory (even with identical IDs).
  const result = await prepare({ prdDir: next });
  // Then state is archived before reset, not configuration or PRD.
  expect(result.archiveDir).toBeDefined();
  if (!result.archiveDir) throw new Error("expected archive");
  for (const name of names) {
    expect(readFileSync(join(result.archiveDir, name), "utf8")).toBe(name);
    expect(existsSync(join(configDir, name))).toBe(false);
  }
  expect(readFileSync(join(configDir, "looper.yml"), "utf8")).toBe("config");
  expect(readFileSync(join(configDir, "work.md"), "utf8")).toBe("prompt");
  expect(existsSync(join(configDir, ".looper-state-lock.sqlite"))).toBe(true);
  expect(existsSync(join(next, "prd.json"))).toBe(true);
});

test("keeps phases when story IDs change at the same path", async () => {
  // Given an associated PRD whose contents change.
  await prepare(); writeFileSync(statePath(), "phases");
  writeFileSync(join(prdDir, "prd.json"), '{"userStories":[{"id":"NEW-7"}]}');
  // When reopening; Then no reset.
  const result = await prepare();
  expect(result.archiveDir).toBeUndefined();
  expect(readFileSync(statePath(), "utf8")).toBe("phases");
});

test("adopts legacy state after an interactive decision", async () => {
  // Given unassociated phases.
  writeFileSync(statePath(), "phases");
  // When explicitly adopting; Then data survives.
  await prepare({ choose: async () => "adopt" });
  expect(readFileSync(statePath(), "utf8")).toBe("phases");
  expect(existsSync(identityPath())).toBe(true);
});

test("fails closed on corrupt checkpoints even with explicit reset", async () => {
  // Given an unreadable generation record.
  writeFileSync(join(configDir, ".looper-run.json"), "{");
  writeFileSync(statePath(), "phases");
  // When resetting; Then it cannot erase session evidence.
  await expect(prepare({ decision: "reset" })).rejects.toThrow();
  expect(readFileSync(statePath(), "utf8")).toBe("phases");
  expect(existsSync(join(configDir, ".looper-archive"))).toBe(false);
});

test("waits for recorded sessions before archival and preserves state on uncertainty", async () => {
  // Given an in-flight step and adjudicator.
  writeFileSync(join(configDir, ".looper-run.json"), JSON.stringify({ iteration: 1, stepIndex: 0, stepName: "Build", sessionID: "ses_step", updatedAt: "now" }));
  writeFileSync(join(configDir, ".looper-adjudicate-session.json"), '{"sessionID":"ses_judge"}');
  writeFileSync(statePath(), "phases");
  // When stopping fails; Then no archive/reset/identity write is authorized.
  await expect(prepare({ decision: "reset", stopSessions: async (ids) => {
    expect(ids).toContain("ses_step"); expect(ids).toContain("ses_judge");
    expect(existsSync(statePath())).toBe(true);
    throw new Error("unconfirmed stop");
  } })).rejects.toThrow("unconfirmed stop");
  expect(readFileSync(statePath(), "utf8")).toBe("phases");
  expect(existsSync(identityPath())).toBe(false);
});

test("refuses missing PRD without erasing state", async () => {
  // Given valid associated state and a missing configured path.
  await prepare(); writeFileSync(statePath(), "phases");
  // When explicitly resetting; Then missing is not a new identity.
  await expect(prepare({ prdDir: join(root, "missing"), decision: "reset" })).rejects.toThrow();
  expect(readFileSync(statePath(), "utf8")).toBe("phases");
});

test("rejects concurrent state changes during reconciliation", async () => {
  // Given legacy phases.
  writeFileSync(statePath(), "before");
  // When another writer changes them while sessions stop; Then preserve the new data.
  await expect(prepare({ decision: "reset", stopSessions: async () => { writeFileSync(statePath(), "after"); } })).rejects.toThrow("changed");
  expect(readFileSync(statePath(), "utf8")).toBe("after");
});

test("keeps all originals when archive creation fails", async () => {
  // Given an invalid archive destination.
  writeFileSync(statePath(), "phases"); writeFileSync(join(configDir, ".looper-archive"), "obstruction");
  // When reset cannot archive; Then nothing is erased.
  await expect(prepare({ decision: "reset" })).rejects.toThrow();
  expect(readFileSync(statePath(), "utf8")).toBe("phases");
  expect(readdirSync(configDir)).not.toContain(".looper-prd-identity.json");
});

test("parses mutually exclusive adopt and reset escape hatches", () => {
  // Given explicit CLI decisions; When parsed; Then preserve their discriminant.
  expect(parseArgs(["--adopt-prd-state"]).prdStateDecision).toBe("adopt");
  expect(parseArgs(["--reset-prd-state"]).prdStateDecision).toBe("reset");
  expect(() => parseArgs(["--adopt-prd-state", "--reset-prd-state"])).toThrow();
});

test("adopts a moved PRD without resetting phases", async () => {
  // Given an associated PRD now at a new path.
  await prepare(); writeFileSync(statePath(), "phases");
  const moved = join(root, "moved"); mkdirSync(moved);
  writeFileSync(join(moved, "prd.json"), '{"userStories":[]}');
  // When explicitly adopting the existing state; Then only its association changes.
  await prepare({ prdDir: moved, decision: "adopt" });
  expect(readFileSync(statePath(), "utf8")).toBe("phases");
  expect(JSON.parse(readFileSync(identityPath(), "utf8")).prdDir).toBe(moved);
  expect(existsSync(join(configDir, ".looper-archive"))).toBe(false);
});

test("normalizes symlink aliases without inferring a PRD switch", async () => {
  // Given an alias for the same directory.
  await prepare(); writeFileSync(statePath(), "phases");
  const alias = join(root, "alias"); symlinkSync(prdDir, alias);
  // When using its alias; Then retain the same association.
  expect((await prepare({ prdDir: alias })).archiveDir).toBeUndefined();
  expect(readFileSync(statePath(), "utf8")).toBe("phases");
});

test("identity survives normal checkpoint cleanup", async () => {
  // Given associated state; When normal run cleanup removes checkpoints.
  await prepare(); createRunStateStore({ configDir }).clearRunArtifacts();
  // Then the PRD association remains independent.
  expect(JSON.parse(readFileSync(identityPath(), "utf8")).prdDir).toBe(prdDir);
});

test.each([".looper-adjudicate-session.json", ".looper-resume-step.json", ".looper-agents.json", ".looper-prd-identity.json"])("retains corrupt %s rather than treating it as absent", async (name) => {
  // Given a corrupt safety record; When explicitly resetting.
  writeFileSync(join(configDir, name), "{");
  // Then preserve evidence and refuse generation.
  await expect(prepare({ decision: "reset" })).rejects.toThrow();
  expect(readFileSync(join(configDir, name), "utf8")).toBe("{");
});

test("refuses an interrupted reset even with an explicit reset flag", async () => {
  // Given a reset journal from a process that died during deletion.
  writeFileSync(join(configDir, ".looper-prd-reset.json"), '{"archiveDir":"saved"}');
  // When reopening; Then require recovery rather than trusting partial state.
  await expect(prepare({ decision: "reset" })).rejects.toThrow("Interrupted PRD reset");
});

test("requires confirmation when PRD configuration is removed", async () => {
  // Given a previously associated PRD.
  await prepare(); writeFileSync(statePath(), "phases");
  // When removing prd configuration; Then it is ambiguous, not an automatic reset.
  await expect(prepare({ prdDir: undefined })).rejects.toThrow("--adopt-prd-state");
  expect(readFileSync(statePath(), "utf8")).toBe("phases");
});

test("archives checkpoint, adjudicator and trail only after their work stops", async () => {
  // Given old in-flight work including a child retained in the trail.
  const files = {
    ".looper-run.json": { iteration: 1, stepIndex: 0, stepName: "Build", sessionID: "step", updatedAt: "now" },
    ".looper-adjudicate-session.json": { sessionID: "judge" },
    ".looper-agents.json": { version: 1, agents: [{ sessionID: "prior", status: "done", finishedAt: 10, children: [{ sessionID: "child" }] }] },
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(configDir, name), JSON.stringify(content));
  let stopped = false;
  // When all recorded work confirms stopped; Then archive the complete evidence.
  const result = await prepare({ decision: "reset", stopSessions: async ids => {
    expect(new Set(ids)).toEqual(new Set(["step", "judge", "prior", "child"])); stopped = true;
  } });
  expect(stopped).toBe(true);
  if (!result.archiveDir) throw new Error("expected archive");
  for (const name of Object.keys(files)) expect(existsSync(join(result.archiveDir, name))).toBe(true);
});
