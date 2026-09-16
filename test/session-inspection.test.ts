import { expect, test } from "bun:test";
import { firstSessionPrompt, inspectSessionMessages } from "../src/lib/session-inspection.ts";
import { assistantMessage, userMessage } from "./fixtures/session-messages.ts";

test("reports the selected session's actual model, variant, and usage regardless of response order", () => {
  const result = inspectSessionMessages("ses_child", [
    assistantMessage("ses_child"),
    assistantMessage("ses_foreign", { time: { created: 10 }, modelID: "wrong-owner" }),
    userMessage("ses_child"),
  ], 123);
  expect(result).toMatchObject({ sessionID: "ses_child", status: "ready", observedAt: 123,
    metadata: { model: "openai/reported-model", variant: "low", source: "reported", variantSource: "reported",
      cost: 0.0123, tokens: { input: 240, output: 80, reasoning: 25, cacheRead: 120, cacheWrite: 10 } } });
});

test("labels pending requests instead of inheriting the previous turn's model", () => {
  const result = inspectSessionMessages("ses_child", [
    assistantMessage("ses_child"),
    userMessage("ses_child", { id: "msg_new", time: { created: 3 }, model: { providerID: "other", modelID: "new-model" } }),
  ]);
  expect(result.metadata).toMatchObject({ messageID: "msg_new", source: "requested", model: "other/new-model" });
  expect(result.metadata?.variant).toBeUndefined();
  expect(result.metadata?.tokens).toBeUndefined();
});

test("only falls back to a variant requested by the assistant's matching parent turn", () => {
  const user = userMessage("ses_child");
  const withoutVariant = assistantMessage("ses_child", { variant: undefined });
  expect(inspectSessionMessages("ses_child", [user, withoutVariant]).metadata).toMatchObject({ variant: "high", variantSource: "requested" });
  const unrelated = assistantMessage("ses_child", { variant: undefined, parentID: "msg_missing" });
  expect(inspectSessionMessages("ses_child", [user, unrelated]).metadata?.variant).toBeUndefined();
  expect(inspectSessionMessages("ses_child", []).metadata).toBeUndefined();
});

test("shows the complete original child prompt, not a continuation or another session's prompt", () => {
  const text = "Original assignment\nSecond paragraph\n<!-- OMO_INTERNAL_INITIATOR -->";
  const messages = [
    userMessage("ses_child", { id: "msg_continue", time: { created: 3 } }, "Continue working."),
    userMessage("ses_foreign", { time: { created: 0 } }, "Wrong prompt."),
    userMessage("ses_child", {}, text),
  ];
  expect(firstSessionPrompt(messages, "ses_child")).toBe("Original assignment\nSecond paragraph");
  expect(firstSessionPrompt([], "ses_child")).toBeUndefined();
});
