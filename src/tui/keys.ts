import type { CliRenderer, KeyEvent } from "@opentui/core";

import type { LoopState, ScrollDirection } from "../lib/state.ts";
import {
  enterHistoryView,
  exitHistoryView,
  historyMoveIteration,
  historyMoveStep,
  requestScrollIntent,
  selectNextStep,
  selectPreviousStep,
  setFocusedPane,
  syncSelectionToActiveStep,
  toggleFocusedPane,
} from "../lib/state.ts";

export type KeyHooks = {
  onInterrupt: () => void;
  onQuit: () => void;
  onRestart: () => void;
  onSkip: () => void;
  onStart: () => void;
  onStopAfterIteration: () => void;
  onTogglePause: () => void;
};

function normalizeKeyName(event: KeyEvent): string {
  return (event.name ?? "").toLowerCase().replaceAll("_", "").replaceAll(" ", "");
}

function isInterruptKey(event: KeyEvent): boolean {
  const keyName = normalizeKeyName(event);
  return (event.ctrl && (keyName === "c" || keyName === "ctrlc")) || event.sequence === "\u0003" || event.raw === "\u0003";
}

function selectedStepIndex(state: LoopState): number | null {
  if (state.selectedStepIndex !== null) return state.selectedStepIndex;
  if (state.activeStepIndex !== null) return state.activeStepIndex;
  return null;
}

function scrollSelectedStepOutput(state: LoopState, direction: ScrollDirection): void {
  if (state.selectedStepIndex === null) syncSelectionToActiveStep(state);

  const stepIndex = selectedStepIndex(state);
  if (stepIndex === null) return;
  if (!state.steps[stepIndex]) return;

  setFocusedPane(state, "output");
  requestScrollIntent(state, direction, stepIndex);
}

const HISTORY_SCROLL_KEYS: Record<string, ScrollDirection> = {
  up: "up",
  down: "down",
  pageup: "pageup",
  pagedown: "pagedown",
  home: "home",
  end: "end",
};

function historyNavAction(state: LoopState, keyName: string): (() => void) | null {
  if (keyName === "tab") return () => toggleFocusedPane(state);
  if (keyName === "left") return () => historyMoveIteration(state, -1);
  if (keyName === "right") return () => historyMoveIteration(state, 1);
  if (state.focusedPane === "steps") {
    if (keyName === "up") return () => historyMoveStep(state, -1);
    if (keyName === "down") return () => historyMoveStep(state, 1);
    return null;
  }
  const direction = HISTORY_SCROLL_KEYS[keyName];
  if (direction === undefined) return null;
  const stepIndex = state.historyView?.stepIndex ?? 0;
  return () => requestScrollIntent(state, direction, stepIndex);
}

export function bindKeys(renderer: CliRenderer, state: LoopState, hooks: KeyHooks): () => void {
  const handleKeyPress = (event: KeyEvent): void => {
    if (isInterruptKey(event)) {
      hooks.onInterrupt();
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      return;
    }

    if (event.ctrl) return;

    const keyName = normalizeKeyName(event);

    if (keyName === "h") {
      if (state.historyView !== null) exitHistoryView(state);
      else enterHistoryView(state);
      if (typeof event.preventDefault === "function") event.preventDefault();
      return;
    }

    if (state.historyView !== null) {
      const historyAction = historyNavAction(state, keyName);
      if (historyAction !== null) {
        historyAction();
        if (typeof event.preventDefault === "function") event.preventDefault();
        return;
      }
    }

    const action =
      keyName === "q"
        ? hooks.onQuit
        : keyName === "g" || keyName === "return" || keyName === "enter"
          ? hooks.onStart
          : keyName === "e"
            ? hooks.onStopAfterIteration
            : keyName === "p"
              ? hooks.onTogglePause
              : keyName === "r"
                ? hooks.onRestart
                : keyName === "s"
                  ? hooks.onSkip
                  : keyName === "tab"
                    ? () => {
                        toggleFocusedPane(state);
                        if (state.focusedPane === "output" && state.selectedStepIndex === null) {
                          syncSelectionToActiveStep(state);
                        }
                      }
                    : state.focusedPane === "steps" && keyName === "up"
                      ? () => selectPreviousStep(state)
                      : state.focusedPane === "steps" && keyName === "down"
                        ? () => selectNextStep(state)
                        : state.focusedPane === "output" && keyName === "up"
                          ? () => scrollSelectedStepOutput(state, "up")
                          : state.focusedPane === "output" && keyName === "down"
                            ? () => scrollSelectedStepOutput(state, "down")
                            : state.focusedPane === "output" && keyName === "pageup"
                              ? () => scrollSelectedStepOutput(state, "pageup")
                              : state.focusedPane === "output" && keyName === "pagedown"
                                ? () => scrollSelectedStepOutput(state, "pagedown")
                                : state.focusedPane === "output" && keyName === "home"
                                  ? () => scrollSelectedStepOutput(state, "home")
                                  : state.focusedPane === "output" && keyName === "end"
                                    ? () => scrollSelectedStepOutput(state, "end")
                                    : null;

    if (!action) return;

    action();

    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
  };

  renderer.keyInput.on("keypress", handleKeyPress);

  return () => {
    renderer.keyInput.off("keypress", handleKeyPress);
  };
}
