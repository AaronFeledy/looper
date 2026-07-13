import { describe, expect, test } from "bun:test";

import { MalformedModelError, parseModel } from "../src/opencode/step-runner-types.ts";

describe("parseModel", () => {
  test("returns undefined when no model is configured", () => {
    expect(parseModel(undefined)).toBeUndefined();
    expect(parseModel("")).toBeUndefined();
  });

  test("splits provider and model on the first slash", () => {
    expect(parseModel("openai/gpt-5.5")).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
  });

  test("keeps extra slashes inside the model id", () => {
    expect(parseModel("openrouter/meta/llama-3")).toEqual({ providerID: "openrouter", modelID: "meta/llama-3" });
  });

  test("throws instead of silently dropping a model without a separator", () => {
    expect(() => parseModel("bogus")).toThrow(MalformedModelError);
    expect(() => parseModel("bogus")).toThrow(/must be "provider\/model"/);
  });

  test("throws on an empty provider or empty model id", () => {
    expect(() => parseModel("/gpt-5.5")).toThrow(MalformedModelError);
    expect(() => parseModel("openai/")).toThrow(MalformedModelError);
  });
});
