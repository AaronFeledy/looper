import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPromptFilesExist,
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

  test("parses variant string, null disable, and rejects empty string", () => {
    withConfigDir(
      [
        "steps:",
        "  named:",
        "    prompt: hi",
        "    variant: low",
        "  disabled:",
        "    prompt: hi",
        "    variant: null",
        "  omitted:",
        "    prompt: hi",
      ].join("\n"),
      (dir) => {
        const steps = loadSteps(dir);
        const byName = Object.fromEntries(steps.map((step) => [step.name, step]));
        expect(byName["Named"]?.variant).toBe("low");
        expect(byName["Disabled"]?.variant).toBeNull();
        expect(byName["Omitted"]?.variant).toBeUndefined();
      },
    );

    withConfigDir("steps:\n  build:\n    prompt: hi\n    variant: \"\"\n", (dir) => {
      expect(() => loadSteps(dir)).toThrow(/variant cannot be empty/);
    });
  });

  test("parses opencode.title.variant null as explicit disable", () => {
    withConfigDir(
      ["opencode:", "  title:", "    variant: null", "steps:", "  build:", "    prompt: hi"].join("\n"),
      (dir) => {
        expect(loadRuntimeConfig(dir).title).toEqual({ variant: null });
      },
    );
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
      expect(cfg.prdDir).toBeUndefined();
      expect(cfg.useSessionIdle).toBe(false);
      expect(cfg.vcsSummary).toBe(false);
      expect(cfg.validateResources).toBe(false);
    });
  });

  test("parses an absolute prd directory", () => {
    withConfigDir("prd: /tmp/looper-prd\nsteps:\n  build:\n    prompt: hi\n", (dir) => {
      expect(loadRuntimeConfig(dir).prdDir).toBe("/tmp/looper-prd");
    });
  });

  test("resolves a relative prd directory against the repo dir", () => {
    withConfigDir("prd: specs/beta-1\nsteps:\n  build:\n    prompt: hi\n", (dir) => {
      expect(loadRuntimeConfig(dir, "/repo/project").prdDir).toBe("/repo/project/specs/beta-1");
    });
  });

  test("rejects an empty prd directory", () => {
    withConfigDir("prd: \"\"\nsteps:\n  build:\n    prompt: hi\n", (dir) => {
      expect(() => loadRuntimeConfig(dir)).toThrow(/prd cannot be empty/);
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
        prd: true,
      });
    });
  });

  test("parses a root context: mapping of known keys to booleans", () => {
    withConfigDir(
      ["context:", "  vcsDelta: false", "  sessionIds: false", "  prd: false", "steps:", "  build:", "    prompt: hi"].join("\n"),
      (dir) => {
        const cfg = loadRuntimeConfig(dir);
        expect(cfg.contextPolicy).toEqual({ vcsDelta: false, sessionIds: false, prd: false });
        const steps = loadSteps(dir);
        expect(resolveContextPolicy(steps[0]!, cfg)).toEqual({
          datetime: true,
          repoDir: true,
          loopPosition: true,
          timebox: true,
          vcsDelta: false,
          sessionIds: false,
          prd: false,
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
          prd: true,
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
        prd: false,
      });
      const steps = loadSteps(dir);
      expect(resolveContextPolicy(steps[0]!, cfg)).toEqual({
        datetime: false,
        repoDir: false,
        loopPosition: false,
        timebox: false,
        vcsDelta: false,
        sessionIds: false,
        prd: false,
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
          prd: false,
        });
      },
    );
  });

  test("rejects an unknown context key, naming the key and valid keys", () => {
    withConfigDir(["context:", "  bogus: true", "steps:", "  build:", "    prompt: hi"].join("\n"), (dir) => {
      expect(() => loadRuntimeConfig(dir)).toThrow(/bogus/);
      expect(() => loadRuntimeConfig(dir)).toThrow(
        /datetime.*repoDir.*loopPosition.*timebox.*vcsDelta.*sessionIds.*prd/s,
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

  test("rejects a non-boolean prd context value", () => {
    withConfigDir(["context:", "  prd: no", "steps:", "  build:", "    prompt: hi"].join("\n"), (dir) => {
      expect(() => loadRuntimeConfig(dir)).toThrow(/context\.prd must be a boolean/);
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

describe("assertPromptFilesExist", () => {
  test("lists every step whose prompt file is missing", () => {
    withConfigDir("steps:\n  build:\n    prompt: build.md\n  review:\n    prompt: review.md\n", (dir) => {
      writeFileSync(join(dir, "build.md"), "do the build\n");
      const steps = loadSteps(dir);
      expect(() => assertPromptFilesExist(steps)).toThrow(/missing prompt file/);
      expect(() => assertPromptFilesExist(steps)).toThrow(/Review: .*review\.md/);
      expect(() => assertPromptFilesExist(steps)).not.toThrow(/Build: .*build\.md/);
    });
  });

  test("passes when every prompt file exists", () => {
    withConfigDir("steps:\n  build:\n    prompt: build.md\n", (dir) => {
      writeFileSync(join(dir, "build.md"), "do the build\n");
      expect(() => assertPromptFilesExist(loadSteps(dir))).not.toThrow();
    });
  });
});
