import type { BoxRenderable, CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { selectedHistoryStep, selectedOrActiveStep } from "../lib/state.ts";
import { createTextDialog } from "./dialog.ts";

function promptModalContent(state: LoopState): { title: string; body: string } {
  const step = state.historyView === null ? selectedOrActiveStep(state) : selectedHistoryStep(state)?.step ?? null;
  if (step === null) {
    return { title: "step prompt", body: "No step selected." };
  }
  const prompt = step.promptText;
  const title = "step prompt";
  if (prompt === undefined || prompt.length === 0) {
    return {
      title,
      body: `No stored prompt for step "${step.name}".\n\n(Only looper-sent step prompts are kept for this view.)`,
    };
  }
  return { title, body: prompt };
}

export function createPromptOverlay(renderer: CliRenderer, state: LoopState): BoxRenderable {
  return createTextDialog(renderer, state, {
    id: "loop-prompt",
    borderColor: "#f9e2af",
    width: "80%",
    height: "70%",
    maxWidth: 100,
    maxHeight: 40,
    minHeight: 10,
    isVisible: (s) => s.promptModalVisible,
    content: promptModalContent,
  });
}
