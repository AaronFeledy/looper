import type { CliRenderer, KeyEvent } from "@opentui/core";

import type { LoopState, RecoveryChoice, ScrollDirection } from "../lib/state.ts";
import {
  dismissEscConfirm,
  enterHistoryView,
  exitHistoryView,
  hideConfigModal,
  hideHelp,
  hidePromptModal,
  historyMoveIteration,
  historyMoveStep,
  requestScrollIntent,
  selectNextStep,
  selectPreviousStep,
  setFocusedPane,
  showHelp,
  syncSelectionToActiveStep,
  toggleConfigModal,
  toggleFocusedPane,
  togglePromptModal,
} from "../lib/state.ts";
import { tryOpenCurrentPr } from "./github-status.ts";

export type KeyHooks = {
  onEscape: () => void;
  onInterrupt: () => void;
  onQuit: () => void;
  onRecoveryChoice: (choice: RecoveryChoice) => void;
  onRestart: () => void;
  onSkip: () => void;
  onStart: () => void;
  onStopAfterIteration: () => void;
  onTogglePause: () => void;
};

function normalizeKeyName(event: KeyEvent): string {
  return (event.name ?? "").toLowerCase().replaceAll("_", "").replaceAll(" ", "");
}

export function isInterruptKey(event: KeyEvent): boolean {
  const keyName = normalizeKeyName(event);
  return (event.ctrl && (keyName === "c" || keyName === "ctrlc")) || event.sequence === "\u0003" || event.raw === "\u0003";
}

export function installBootInterruptHandler(renderer: CliRenderer, onInterrupt: () => void): () => void {
  const handleKeyPress = (event: KeyEvent): void => {
    if (!isInterruptKey(event)) return;
    onInterrupt();
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
  };

  renderer.keyInput.on("keypress", handleKeyPress);
  return () => renderer.keyInput.off("keypress", handleKeyPress);
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
    const keyName = normalizeKeyName(event);
    const isEscape = keyName === "escape" || keyName === "esc";

    // Help / prompt / config overlays are modal: while visible, the next keypress only closes them.
    if (state.helpVisible) {
      hideHelp(state);
      if (typeof event.preventDefault === "function") event.preventDefault();
      return;
    }
    if (state.promptModalVisible) {
      hidePromptModal(state);
      if (typeof event.preventDefault === "function") event.preventDefault();
      return;
    }
    if (state.configModalVisible) {
      hideConfigModal(state);
      if (typeof event.preventDefault === "function") event.preventDefault();
      return;
    }

    if (isInterruptKey(event)) {
      if (state.escConfirm !== null) dismissEscConfirm(state);
      const selectedText = renderer.getSelection()?.getSelectedText() ?? "";
      if (selectedText.length > 0) {
        renderer.copyToClipboardOSC52(selectedText);
        renderer.clearSelection();
      } else {
        hooks.onInterrupt();
      }
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      return;
    }

    if (isEscape) {
      hooks.onEscape();
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      return;
    }

    if (keyName === "?" || event.sequence === "?") {
      showHelp(state);
      if (typeof event.preventDefault === "function") event.preventDefault();
      return;
    }

    if (keyName === "v") {
      togglePromptModal(state);
      if (typeof event.preventDefault === "function") event.preventDefault();
      return;
    }

    if (keyName === "c") {
      toggleConfigModal(state);
      if (typeof event.preventDefault === "function") event.preventDefault();
      return;
    }

    // Any other key cancels a pending two-press esc confirmation.
    if (state.escConfirm !== null) dismissEscConfirm(state);

    if (event.ctrl) return;

    if (state.recovery !== null) {
      const choice: RecoveryChoice | null = keyName === "r" ? "restart" : keyName === "n" ? "nudge" : keyName === "q" ? "quit" : null;
      if (choice !== null) {
        hooks.onRecoveryChoice(choice);
        if (typeof event.preventDefault === "function") event.preventDefault();
        return;
      }
      if (typeof event.preventDefault === "function") event.preventDefault();
      return;
    }

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
        : (keyName === "return" || keyName === "enter") && state.focusedPane === "github"
          ? () => tryOpenCurrentPr(state)
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
