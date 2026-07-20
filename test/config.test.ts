import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPromptFilesExist,
  loadAdjudicateStep,
  loadRuntimeConfig,
  loadSteps,
  resolveContextPolicy,
  resolvePermissionAction,
  type PermissionAction,
} from "../src/lib/config.ts";
import { prdFlipThreshold } from "../src/config/tunables.ts";

function withConfigDir(contents: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "looper-config-"));
  try {
    writeFileSync(join(dir, "looper.yml"), contents);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withPrdFlipThresholdEnv(value: string | undefined, run: () => void): void {
  const original = process.env["LOOPER_PRD_FLIP_THRESHOLD"];
  try {
    if (value === undefined) delete process.env["LOOPER_PRD_FLIP_THRESHOLD"];
    else process.env["LOOPER_PRD_FLIP_THRESHOLD"] = value;
    run();
  } finally {
    if (original === undefined) delete process.env["LOOPER_PRD_FLIP_THRESHOLD"];
    else process.env["LOOPER_PRD_FLIP_THRESHOLD"] = original;
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

  test("parses every gate condition and setsPhase", () => {
    withConfigDir(
      [
        "prd: specs/beta-1",
        "steps:",
        "  build:",
        "    prompt: hi",
        "    gate:",
        "      branch: story",
        "      prdPasses: true",
        "      phase: reviewed",
        "      script: test -f ready",
        "    setsPhase: verified",
      ].join("\n"),
      (dir) => {
        expect(loadSteps(dir)[0]).toMatchObject({
          gate: {
            branch: "story",
            prdPasses: true,
            phase: "reviewed",
            script: "test -f ready",
          },
          setsPhase: "verified",
        });
      },
    );
  });

  test.each([
    ["gate is not a mapping", "    gate: story", /steps\.build\.gate must be a mapping/],
    ["gate has an unknown key", "    gate:\n      bogus: true", /steps\.build\.gate\.bogus is not a valid gate key/],
    ["branch is invalid", "    gate:\n      branch: release", /steps\.build\.gate\.branch must be \"story\" or \"main\"/],
    ["prdPasses is false", "    gate:\n      prdPasses: false", /steps\.build\.gate\.prdPasses must be true/],
    ["phase is invalid", "    gate:\n      phase: shipped", /steps\.build\.gate\.phase must be one of:/],
    ["script is not a string", "    gate:\n      script: 42", /steps\.build\.gate\.script must be a string/],
    ["script is empty", '    gate:\n      script: ""', /steps\.build\.gate\.script cannot be empty/],
  ])("rejects an invalid gate when %s", (_description, gateYaml, expected) => {
    withConfigDir(`steps:\n  build:\n    prompt: hi\n${gateYaml}\n`, (dir) => {
      expect(() => loadSteps(dir)).toThrow(expected);
    });
  });

  test("rejects an invalid setsPhase", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n    setsPhase: shipped\n", (dir) => {
      expect(() => loadSteps(dir)).toThrow(/steps\.build\.setsPhase must be one of:/);
    });
  });

  test("continues to ignore unknown step keys", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n    futureGateFeature: enabled\n", (dir) => {
      expect(loadSteps(dir)).toHaveLength(1);
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

  test("rejects a step model without a provider/model separator", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n    model: bogus\n", (dir) => {
      expect(() => loadSteps(dir)).toThrow(/steps\.build\.model must be "provider\/model"/);
    });
  });

  test("rejects a step model with an empty provider", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n    model: /gpt-5.5\n", (dir) => {
      expect(() => loadSteps(dir)).toThrow(/steps\.build\.model must be "provider\/model"/);
    });
  });

  test("rejects a step model with an empty model id", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n    model: openai/\n", (dir) => {
      expect(() => loadSteps(dir)).toThrow(/steps\.build\.model must be "provider\/model"/);
    });
  });

  test("accepts a well-formed provider/model step model", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n    model: openai/gpt-5.5\n", (dir) => {
      expect(loadSteps(dir)[0]!.model).toBe("openai/gpt-5.5");
    });
  });

  test("accepts a model id containing extra slashes after the provider", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n    model: openrouter/meta/llama-3\n", (dir) => {
      expect(loadSteps(dir)[0]!.model).toBe("openrouter/meta/llama-3");
    });
  });

  test("rejects a malformed opencode.title.model", () => {
    withConfigDir(
      ["opencode:", "  title:", "    model: bogus", "steps:", "  build:", "    prompt: hi"].join("\n"),
      (dir) => {
        expect(() => loadRuntimeConfig(dir)).toThrow(/opencode\.title\.model must be "provider\/model"/);
      },
    );
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

describe("adjudicate config parsing", () => {
  test("parses every step field and resolves prompt paths relative to the config directory", () => {
    withConfigDir(
      [
        "adjudicate:",
        "  name: Final Decision",
        "  agent: build",
        "  variant: low",
        "  model: openai/gpt-5.5",
        "  prompt: prompts/adjudicate.md",
        "  prefix: before",
        "  suffix: after",
        "  args: [one, two]",
        "  timeout: 30m",
        "  title: branch",
        "  permissionPolicy:",
        "    edit: always",
        "  questionPolicy: reject",
        "  context:",
        "    prd: false",
        "  gate:",
        "    branch: main",
        "  setsPhase: merged",
        "steps:",
        "  build:",
        "    prompt: build.md",
      ].join("\n"),
      (dir) => {
        expect(loadAdjudicateStep(dir)).toEqual({
          name: "Final Decision",
          agent: "build",
          variant: "low",
          model: "openai/gpt-5.5",
          prompt: join(dir, "prompts/adjudicate.md"),
          prefix: "before",
          suffix: "after",
          args: ["one", "two"],
          timeoutMs: 30 * 60 * 1000,
          title: "branch",
          permissionPolicy: { edit: "always" },
          questionPolicy: "reject",
          contextPolicy: { prd: false },
          gate: { branch: "main" },
          setsPhase: "merged",
        });
      },
    );
  });

  test("defaults the step name to adjudicate", () => {
    withConfigDir("adjudicate:\n  prompt: adjudicate.md\nsteps:\n  build:\n    prompt: build.md\n", (dir) => {
      expect(loadAdjudicateStep(dir)?.name).toBe("adjudicate");
    });
  });

  test("returns undefined when adjudicate is absent", () => {
    withConfigDir("steps:\n  build:\n    prompt: build.md\n", (dir) => {
      expect(loadAdjudicateStep(dir)).toBeUndefined();
    });
  });

  test("keeps adjudicate out of the ordered steps array", () => {
    withConfigDir(
      "adjudicate:\n  prompt: adjudicate.md\nsteps:\n  build:\n    prompt: build.md\n  review:\n    prompt: review.md\n",
      (dir) => {
        expect(loadSteps(dir).map((step) => step.name)).toEqual(["Build", "Review"]);
      },
    );
  });

  test("rejects a malformed adjudicate block in step-mapping style", () => {
    withConfigDir("adjudicate: nope\nsteps:\n  build:\n    prompt: build.md\n", (dir) => {
      expect(() => loadAdjudicateStep(dir)).toThrow(/adjudicate must be a mapping/);
    });
  });
});

describe("loadRuntimeConfig policy and flags", () => {
  test("defaults preserve legacy behavior when keys are absent", () => {
    withConfigDir("steps:\n  build:\n    prompt: hi\n", (dir) => {
      const cfg = loadRuntimeConfig(dir);
      expect(cfg.permissionPolicy).toBeUndefined();
      expect(cfg.questionPolicy).toBeUndefined();
      expect(cfg.prdDir).toBeUndefined();
      expect(cfg.storyIdPattern).toBeUndefined();
      expect(cfg.useSessionIdle).toBe(false);
      expect(cfg.validateResources).toBe(false);
    });
  });

  test("parses a top-level storyIdPattern", () => {
    withConfigDir("storyIdPattern: '^story/([a-z]+-[0-9]+)$'\nsteps:\n  build:\n    prompt: hi\n", (dir) => {
      expect(loadRuntimeConfig(dir).storyIdPattern).toBe("^story/([a-z]+-[0-9]+)$");
    });
  });

  test("rejects an empty storyIdPattern", () => {
    withConfigDir('storyIdPattern: ""\nsteps:\n  build:\n    prompt: hi\n', (dir) => {
      expect(() => loadRuntimeConfig(dir)).toThrow(/storyIdPattern cannot be empty/);
    });
  });

  test("rejects a non-string storyIdPattern", () => {
    withConfigDir("storyIdPattern: 74\nsteps:\n  build:\n    prompt: hi\n", (dir) => {
      expect(() => loadRuntimeConfig(dir)).toThrow(/storyIdPattern must be a string/);
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

  test.each(["prdPasses: true", "phase: reviewed"])("rejects a %s gate without prd, naming the step", (gateEntry) => {
    withConfigDir(`steps:\n  build-release:\n    prompt: hi\n    gate:\n      ${gateEntry}\n`, (dir) => {
      expect(() => loadRuntimeConfig(dir)).toThrow(/Build Release.*requires top-level prd:/);
    });
  });

  test("parses a positive prdFlipThreshold", () => {
    withConfigDir("prdFlipThreshold: 4\nsteps:\n  build:\n    prompt: hi\n", (dir) => {
      expect(loadRuntimeConfig(dir).prdFlipThreshold).toBe(4);
    });
  });

  test("rejects a non-positive prdFlipThreshold", () => {
    withConfigDir("prdFlipThreshold: 0\nsteps:\n  build:\n    prompt: hi\n", (dir) => {
      expect(() => loadRuntimeConfig(dir)).toThrow(/prdFlipThreshold must be an integer >= 1/);
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

describe("prdFlipThreshold", () => {
  test("uses the default when env and config are absent", () => {
    withPrdFlipThresholdEnv(undefined, () => {
      expect(prdFlipThreshold()).toBe(2);
    });
  });

  test("uses the YAML config value when env is absent", () => {
    withPrdFlipThresholdEnv(undefined, () => {
      expect(prdFlipThreshold(4)).toBe(4);
    });
  });

  test("prefers the environment value over the YAML config value", () => {
    withPrdFlipThresholdEnv("6", () => {
      expect(prdFlipThreshold(4)).toBe(6);
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
