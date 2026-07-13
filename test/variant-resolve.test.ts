import { describe, expect, test } from "bun:test";

import { OPENCODE_DEFAULT_VARIANT, resolvePromptVariant } from "../src/opencode/variant-resolve.ts";

type ProviderListResult = {
  error?: unknown;
  data?: {
    all: Array<{
      id: string;
      models: Record<string, { id: string; variants?: Record<string, Record<string, unknown>> }>;
    }>;
  };
};

function mockClient(result: ProviderListResult) {
  return {
    provider: {
      list: async () => result,
    },
  } as never;
}

describe("resolvePromptVariant", () => {
  test("maps null to opencode default sentinel", async () => {
    const logs: string[] = [];
    const resolved = await resolvePromptVariant({
      client: mockClient({ data: { all: [] } }),
      repoDir: "/repo",
      model: { providerID: "openai", modelID: "gpt-5.5" },
      variant: null,
      log: (line) => logs.push(line),
    });
    expect(resolved).toBe(OPENCODE_DEFAULT_VARIANT);
    expect(logs).toEqual([]);
  });

  test("omits undefined and empty string", async () => {
    const client = mockClient({ data: { all: [] } });
    await expect(
      resolvePromptVariant({
        client,
        repoDir: "/repo",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        variant: undefined,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolvePromptVariant({
        client,
        repoDir: "/repo",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        variant: "",
      }),
    ).resolves.toBeUndefined();
  });

  test("keeps a named variant listed on the model", async () => {
    const client = mockClient({
      data: {
        all: [
          {
            id: "openai",
            models: {
              "gpt-5.5": { id: "gpt-5.5", variants: { low: {}, high: {} } },
            },
          },
        ],
      },
    });
    await expect(
      resolvePromptVariant({
        client,
        repoDir: "/repo",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        variant: "low",
      }),
    ).resolves.toBe("low");
  });

  test("drops a named variant the model does not list", async () => {
    const logs: string[] = [];
    const client = mockClient({
      data: {
        all: [
          {
            id: "anthropic",
            models: {
              "claude-haiku-4-5": { id: "claude-haiku-4-5", variants: {} },
            },
          },
        ],
      },
    });
    const resolved = await resolvePromptVariant({
      client,
      repoDir: "/repo",
      model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      variant: "high",
      log: (line) => logs.push(line),
    });
    expect(resolved).toBeUndefined();
    expect(logs.some((line) => line.includes("does not support variant=high"))).toBe(true);
  });

  test("forwards named variant when model is unknown so opencode can decide", async () => {
    await expect(
      resolvePromptVariant({
        client: mockClient({ data: { all: [] } }),
        repoDir: "/repo",
        model: undefined,
        variant: "high",
      }),
    ).resolves.toBe("high");
  });

  test("forwards named variant when the provider is not in the listing", async () => {
    await expect(
      resolvePromptVariant({
        client: mockClient({ data: { all: [] } }),
        repoDir: "/repo",
        model: { providerID: "custom", modelID: "my-model" },
        variant: "high",
      }),
    ).resolves.toBe("high");
  });

  test("forwards named variant when the model is not listed under its provider", async () => {
    const client = mockClient({
      data: {
        all: [
          {
            id: "openai",
            models: {
              "gpt-5.5": { id: "gpt-5.5", variants: { low: {} } },
            },
          },
        ],
      },
    });
    await expect(
      resolvePromptVariant({
        client,
        repoDir: "/repo",
        model: { providerID: "openai", modelID: "gpt-6-preview" },
        variant: "high",
      }),
    ).resolves.toBe("high");
  });

  test("drops a named variant when the model is listed without a variants field", async () => {
    const logs: string[] = [];
    const client = mockClient({
      data: {
        all: [
          {
            id: "anthropic",
            models: {
              "claude-haiku-4-5": { id: "claude-haiku-4-5" },
            },
          },
        ],
      },
    });
    const resolved = await resolvePromptVariant({
      client,
      repoDir: "/repo",
      model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      variant: "high",
      log: (line) => logs.push(line),
    });
    expect(resolved).toBeUndefined();
    expect(logs.some((line) => line.includes("does not support variant=high"))).toBe(true);
  });

  test("forwards named variant when provider.list fails", async () => {
    const logs: string[] = [];
    const resolved = await resolvePromptVariant({
      client: mockClient({ error: { message: "offline" } }),
      repoDir: "/repo",
      model: { providerID: "openai", modelID: "gpt-5.5" },
      variant: "high",
      log: (line) => logs.push(line),
    });
    expect(resolved).toBe("high");
    expect(logs.some((line) => line.includes("provider.list failed"))).toBe(true);
  });
});
