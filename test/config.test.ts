import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadRuntimeConfig,
  loadSteps,
  resolveContextPolicy,
  resolvePermissionAction,
  type PermissionAction,
} from "../src/lib/config.ts";

function withConfigDir(contents: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "looper-config-"));
  try {
    writeFileSync(join(dir, "looper.yml"), contents);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadSteps config parsing", () => {
  test("rejects a top-level YAML array", () => {
    withConfigDir("- one\n- two\n", (dir) => {
      expect(() => loadSteps(dir)).toThrow(/must contain a mapping/);
    });
  });

  test("reports malformed YAML instead of leaking a raw parser error", () => {
    withConfigDir("steps: [unclosed\n", (dir) => {
      expect(() => loadSteps(dir)).toThrow(/is not valid YAML/);
    });
  });

  test("applies per-step permissionPolicy and questionPolicy overrides", () => {
    withConfigDir(
      [
        "permissionPolicy:",
        "  bash: once",
        "questionPolicy: reject",
        "steps:",
        "  build:",
        "    prompt: hi",
        "    permissionPolicy:",
        "      edit: always",
        "    questionPolicy: ask",
      ].join("\n"),
      (dir) => {
        const steps = loadSteps(dir);
        expect(steps[0]!.permissionPolicy).toEqual({ edit: "always" });
        expect(steps[0]!.questionPolicy).toBe("ask");
      },
    );
  });

  test("rejects invalid per-step permissionPolicy action", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n    permissionPolicy:\n      edit: maybe\n", (dir) => {
      expect(() => loadSteps(dir)).toThrow(/permissionPolicy/);
    });
  });

  test("ignores a directory named like a config file and falls back", () => {
    const dir = mkdtempSync(join(tmpdir(), "looper-config-"));
    try {
      mkdirSync(join(dir, "looper.yml"));
      writeFileSync(join(dir, "looper.yaml"), "steps:\n  build:\n    prompt: hi\n");
      const steps = loadSteps(dir);
      expect(steps).toHaveLength(1);
      expect(steps[0]!.prompt).toContain("hi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadRuntimeConfig policy and flags", () => {
  test("defaults preserve legacy behavior when keys are absent", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n", (dir) => {
      const cfg = loadRuntimeConfig(dir);
      expect(cfg.permissionPolicy).toBeUndefined();
      expect(cfg.questionPolicy).toBeUndefined();
      expect(cfg.useSessionIdle).toBe(false);
      expect(cfg.vcsSummary).toBe(false);
      expect(cfg.validateResources).toBe(false);
    });
  });

  test("parses global permissionPolicy, questionPolicy, and feature flags", () => {
    withConfigDir(
      [
        "permissionPolicy:",
        "  '*': reject",
        "  edit: always",
        "questionPolicy: reject",
        "useSessionIdle: true",
        "vcsSummary: true",
        "validateResources: true",
        "steps:",
        "  build:",
        "    prompt: hi",
      ].join("\n"),
      (dir) => {
        const cfg = loadRuntimeConfig(dir);
        expect(cfg.permissionPolicy).toEqual({ "*": "reject", edit: "always" });
        expect(cfg.questionPolicy).toBe("reject");
        expect(cfg.useSessionIdle).toBe(true);
        expect(cfg.vcsSummary).toBe(true);
        expect(cfg.validateResources).toBe(true);
      },
    );
  });

  test("rejects invalid global permissionPolicy action", () => {
    withConfigDir(
      "permissionPolicy:\n  bash: yolo\nsteps:\n  build:\n    prompt: hi\n",
      (dir) => {
        expect(() => loadRuntimeConfig(dir)).toThrow(/permissionPolicy/);
      },
    );
  });

  test("rejects invalid questionPolicy", () => {
    withConfigDir("questionPolicy: always\nsteps:\n  build:\n    prompt: hi\n", (dir) => {
      expect(() => loadRuntimeConfig(dir)).toThrow(/questionPolicy/);
    });
  });
});

describe("context policy config parsing", () => {
  test("defaults contextPolicy to undefined and resolves all keys true when absent", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n", (dir) => {
      const cfg = loadRuntimeConfig(dir);
      expect(cfg.contextPolicy).toBeUndefined();
      const steps = loadSteps(dir);
      expect(steps[0]!.contextPolicy).toBeUndefined();
      expect(resolveContextPolicy(steps[0]!, cfg)).toEqual({
        datetime: true,
        repoDir: true,
        loopPosition: true,
        timebox: true,
        vcsDelta: true,
        sessionIds: true,
      });
    });
  });

  test("parses a root context: mapping of known keys to booleans", () => {
    withConfigDir(
      ["context:", "  vcsDelta: false", "  sessionIds: false", "steps:", "  build:", "    prompt: hi"].join("\n"),
      (dir) => {
        const cfg = loadRuntimeConfig(dir);
        expect(cfg.contextPolicy).toEqual({ vcsDelta: false, sessionIds: false });
        const steps = loadSteps(dir);
        expect(resolveContextPolicy(steps[0]!, cfg)).toEqual({
          datetime: true,
          repoDir: true,
          loopPosition: true,
          timebox: true,
          vcsDelta: false,
          sessionIds: false,
        });
      },
    );
  });

  test("per-step context override wins over the global override, per key", () => {
    withConfigDir(
      [
        "context:",
        "  vcsDelta: false",
        "steps:",
        "  build:",
        "    prompt: hi",
        "    context:",
        "      vcsDelta: true",
        "      datetime: false",
      ].join("\n"),
      (dir) => {
        const cfg = loadRuntimeConfig(dir);
        const steps = loadSteps(dir);
        expect(steps[0]!.contextPolicy).toEqual({ vcsDelta: true, datetime: false });
        expect(resolveContextPolicy(steps[0]!, cfg)).toEqual({
          datetime: false,
          repoDir: true,
          loopPosition: true,
          timebox: true,
          vcsDelta: true,
          sessionIds: true,
        });
      },
    );
  });

  test("context: false at root disables all keys", () => {
    withConfigDir(["context: false", "steps:", "  build:", "    prompt: hi"].join("\n"), (dir) => {
      const cfg = loadRuntimeConfig(dir);
      expect(cfg.contextPolicy).toEqual({
        datetime: false,
        repoDir: false,
        loopPosition: false,
        timebox: false,
        vcsDelta: false,
        sessionIds: false,
      });
      const steps = loadSteps(dir);
      expect(resolveContextPolicy(steps[0]!, cfg)).toEqual({
        datetime: false,
        repoDir: false,
        loopPosition: false,
        timebox: false,
        vcsDelta: false,
        sessionIds: false,
      });
    });
  });

  test("context: false per-step disables all keys for that step only", () => {
    withConfigDir(
      ["steps:", "  build:", "    prompt: hi", "    context: false"].join("\n"),
      (dir) => {
        const cfg = loadRuntimeConfig(dir);
        const steps = loadSteps(dir);
        expect(resolveContextPolicy(steps[0]!, cfg)).toEqual({
          datetime: false,
          repoDir: false,
          loopPosition: false,
          timebox: false,
          vcsDelta: false,
          sessionIds: false,
        });
      },
    );
  });

  test("rejects an unknown context key, naming the key and valid keys", () => {
    withConfigDir(["context:", "  bogus: true", "steps:", "  build:", "    prompt: hi"].join("\n"), (dir) => {
      expect(() => loadRuntimeConfig(dir)).toThrow(/bogus/);
      expect(() => loadRuntimeConfig(dir)).toThrow(
        /datetime.*repoDir.*loopPosition.*timebox.*vcsDelta.*sessionIds/s,
      );
    });
  });

  test("rejects an unknown per-step context key", () => {
    withConfigDir(
      ["steps:", "  build:", "    prompt: hi", "    context:", "      bogus: true"].join("\n"),
      (dir) => {
        expect(() => loadSteps(dir)).toThrow(/bogus/);
      },
    );
  });

  test("rejects a non-boolean context value", () => {
    withConfigDir(["context:", "  vcsDelta: yes-please", "steps:", "  build:", "    prompt: hi"].join("\n"), (dir) => {
      expect(() => loadRuntimeConfig(dir)).toThrow(/vcsDelta/);
    });
  });
});

describe("resolvePermissionAction", () => {
  const global = { permissionPolicy: { edit: "once" as PermissionAction, "*": "reject" as PermissionAction } };

  test("prefers step override, then kind, then wildcard, then ask", () => {
    expect(resolvePermissionAction("edit", { permissionPolicy: { edit: "always" } }, global)).toBe("always");
    expect(resolvePermissionAction("bash", {}, global)).toBe("reject");
    expect(resolvePermissionAction("webfetch", { permissionPolicy: { webfetch: "once" } }, {})).toBe("once");
    expect(resolvePermissionAction("unknown", {}, {})).toBe("ask");
  });
});