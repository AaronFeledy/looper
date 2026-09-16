import { setDiagnosticsVisible } from "../lib/tui-diagnostics.ts";
import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { focusPaneTabLabel, nextFocusedPane, subscribe } from "../lib/state.ts";
import { modalFocusWinner } from "./permission-gate.ts";
import { isPauseEngaged } from "./step-list.ts";
import { timeoutExtendHintText } from "./timeout-hint.ts";

/**
 * Middle-row contextual status (flags, gates, overlays). General key hints live in
 * the `?` help overlay; the right-side footer only points at that overlay.
 */
export function footerStatus(state: LoopState): string {
  if (state.escConfirm === "reset") {
    return `Press [esc] again to reset to a fresh run  ·  any other key cancels`;
  }
  if (state.escConfirm === "stop") {
    return `Press [esc] again to stop the run  ·  any other key cancels`;
  }
  if (state.recovery !== null) {
    return `step failed — [r]estart  [n]udge  [q]uit`;
  }
  if (modalFocusWinner(state) === "permission") {
    const keys =
      state.pendingRequests[0]?.kind === "question"
        ? `[d] reject  [s] skip`
        : `[y] once  [a] always  [d] deny  [s] deny + skip`;
    const queued = state.pendingRequests.length > 1 ? `  (+${state.pendingRequests.length - 1} waiting)` : "";
    return `agent is waiting on you - ${keys}${queued}  [q]uit`;
  }
  if (modalFocusWinner(state) === "diagnostics") return "[esc/l] close diagnostics  ·  ↑↓ scroll";
  if (modalFocusWinner(state) === "inspector") return "[esc] close inspector  ·  [tab] section  ·  [c] config";
  if (state.historyView !== null) {
    const navHint =
      state.focusedPane === "steps"
        ? "Up/Down: step"
        : state.focusedPane === "github"
          ? "Enter: open PR"
          : "Up/Down/PageUp/PageDown/Home/End: scroll";
    const tabTarget = focusPaneTabLabel(nextFocusedPane(state));
    return `[h] exit history  Left/Right: iteration  Tab: ${tabTarget}  ${navHint}  [q]uit`;
  }
  if (state.helpVisible) {
    return `press any key to close help`;
  }
  if (state.promptModalVisible) {
    return `press any key to close step prompt`;
  }
  if (state.configModalVisible) {
    return `press any key to close config`;
  }

  if (!state.started && state.bootResumeSession?.workState === "running" && !state.bootResumeSession.canReattach) {
    return "[g] check saved session recovery";
  }
  const flags: string[] = [];
  if (isPauseEngaged(state)) flags.push("paused — press p to resume");
  if (state.stopAfterIteration) flags.push("ending after iteration");
  if (state.restartRequested) flags.push("restarting step");
  if (state.skipRequested) flags.push("skipping step");
  const timeoutHint = timeoutExtendHintText(state.control.timeoutSnapshot());
  if (timeoutHint !== undefined) flags.push(timeoutHint);
  if (state.constellation && flags.length === 0) return "[o/enter] inspect  ·  [b] context  ·  [i] plan";
  return flags.join("  ·  ");
}

export function footerStatusDivider(state: LoopState): string {
  return footerStatus(state).length > 0 ? "·" : "";
}

export function footerBranchLabel(state: LoopState): string {
  return `Branch: ${state.branch || "detached"}`;
}

export function footerHelpHint(): string {
  return "[?] keys";
}

export function footerColor(state: LoopState): string {
  if (state.escConfirm !== null) return "#f38ba8";
  if (state.recovery !== null) return "#f38ba8";
  if (state.pendingRequests.length > 0) return "#f9e2af";
  if (state.historyView !== null) return "#cba6f7";
  const actionable = isPauseEngaged(state) || state.stopAfterIteration || state.skipRequested || state.restartRequested
    || timeoutExtendHintText(state.control.timeoutSnapshot()) !== undefined;
  return actionable ? "#f9e2af" : "#6c7086";
}

const BRANCH_COLOR = "#a6adc8";
const HELP_COLOR = "#6c7086";

export function createFooter(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const footer = new BoxRenderable(renderer, {
    id: "loop-footer",
    width: "100%",
    height: 1,
    flexDirection: "row",
  });

  const branch = new TextRenderable(renderer, {
    id: "loop-footer-branch",
    flexShrink: 0,
    height: 1,
    content: footerBranchLabel(state),
    fg: BRANCH_COLOR,
    truncate: true,
  });

  const divider = new TextRenderable(renderer, {
    id: "loop-footer-divider",
    flexShrink: 0,
    height: 1,
    marginLeft: 1,
    content: footerStatusDivider(state),
    fg: HELP_COLOR,
    visible: footerStatusDivider(state).length > 0,
  });

  const status = new TextRenderable(renderer, {
    id: "loop-footer-text",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    height: 1,
    marginLeft: 1,
    content: footerStatus(state),
    fg: footerColor(state),
    truncate: true,
  });

  const help = new TextRenderable(renderer, {
    id: "loop-footer-help",
    flexShrink: 0,
    height: 1,
    marginLeft: 1,
    content: footerHelpHint(),
    fg: HELP_COLOR,
    truncate: true,
  });

  const diagnostics = new TextRenderable(renderer, {
    id: "loop-footer-diagnostics", flexShrink: 0, height: 1, marginLeft: 1, selectable: false, content: "",
    onMouseUp(event) {
      const winner = modalFocusWinner(state);
      if (event.button === 0 && event.type === "up" && (winner === "none" || winner === "inspector"))
        setDiagnosticsVisible(state, true);
    },
  });

  footer.add(branch);
  footer.add(divider);
  footer.add(status);
  footer.add(diagnostics);
  footer.add(help);

  const paint = () => {
    const dividerText = footerStatusDivider(state);
    branch.content = footerBranchLabel(state);
    divider.content = dividerText;
    divider.visible = dividerText.length > 0;
    status.content = footerStatus(state);
    status.fg = footerColor(state);
    help.content = footerHelpHint();
    diagnostics.visible = Boolean(state.diagnostics?.entries.length);
    diagnostics.content = state.diagnostics?.unread ? `[l] ! ${state.diagnostics.unread} new` : "[l] diagnostics";
    diagnostics.fg = state.diagnostics?.unread ? "#f3bf7a" : HELP_COLOR;
    renderer.requestRender();
  };

  paint();
  const unsubscribe = subscribe(paint);
  const timer = setInterval(paint, 1_000);
  timer.unref?.();

  footer.on(RenderableEvents.DESTROYED, () => {
    clearInterval(timer);
    unsubscribe();
  });

  return footer;
}
