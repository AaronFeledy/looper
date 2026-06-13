import { BoxRenderable, RenderableEvents, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";

import type { GithubStatus, LoopState } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";
import { formatRow, LIST_WIDTH } from "./step-list.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PANEL_BORDER = 2;
const PANEL_PADDING_X = 1;
const TEXT_WIDTH = LIST_WIDTH - PANEL_BORDER - PANEL_PADDING_X * 2;

const COLOR_MUTED = "#6c7086";
const COLOR_TITLE = "#a6adc8";
const COLOR_OPEN = "#a6e3a1";
const COLOR_DRAFT = "#9399b2";
const COLOR_MERGED = "#cba6f7";
const COLOR_CLOSED = "#f38ba8";
const COLOR_PASS = "#a6e3a1";
const COLOR_FAIL = "#f38ba8";
const COLOR_PENDING = "#f9e2af";
const COLOR_NEUTRAL = "#89b4fa";
const COLOR_BUGBOT_ISSUES = "#fab387";

type Line = { content: string; fg: string; attrs: number };

function prStateLabel(status: Extract<GithubStatus, { kind: "pr" }>): string {
  if (status.pr.isDraft && status.pr.state === "OPEN") return "draft";
  return status.pr.state.toLowerCase() || "open";
}

function prStateColor(status: Extract<GithubStatus, { kind: "pr" }>): string {
  if (status.pr.isDraft && status.pr.state === "OPEN") return COLOR_DRAFT;
  if (status.pr.state === "MERGED") return COLOR_MERGED;
  if (status.pr.state === "CLOSED") return COLOR_CLOSED;
  return COLOR_OPEN;
}

function ciLine(status: Extract<GithubStatus, { kind: "pr" }>, frame: string): Line {
  const { ciOverall, ciPassing, ciFailing, ciNeutral, ciTotal } = status.pr;
  if (ciOverall === "none") return { content: "no checks", fg: COLOR_MUTED, attrs: TextAttributes.NONE };
  if (ciOverall === "failing") {
    return { content: formatRow("✗ failing", `${ciFailing}/${ciTotal}`, TEXT_WIDTH), fg: COLOR_FAIL, attrs: TextAttributes.NONE };
  }
  if (ciOverall === "pending") {
    const done = ciPassing + ciFailing + ciNeutral;
    return { content: formatRow(`${frame} running`, `${done}/${ciTotal}`, TEXT_WIDTH), fg: COLOR_PENDING, attrs: TextAttributes.NONE };
  }
  if (ciOverall === "neutral") {
    return { content: formatRow("~ neutral", `${ciNeutral}/${ciTotal}`, TEXT_WIDTH), fg: COLOR_NEUTRAL, attrs: TextAttributes.NONE };
  }
  return { content: formatRow("✓ passing", `${ciPassing}/${ciTotal}`, TEXT_WIDTH), fg: COLOR_PASS, attrs: TextAttributes.NONE };
}

/**
 * Secondary line shown when some checks are NEUTRAL but the overall verdict is
 * something else (passing/failing/pending) — so neutral counts never hide
 * inside the passing tally. When the overall verdict is itself `neutral`,
 * {@link ciLine} already covers it and this returns null.
 */
function neutralLine(status: Extract<GithubStatus, { kind: "pr" }>): Line | null {
  const { ciOverall, ciNeutral } = status.pr;
  if (ciNeutral <= 0 || ciOverall === "neutral") return null;
  return { content: formatRow("~ neutral", `${ciNeutral}`, TEXT_WIDTH), fg: COLOR_NEUTRAL, attrs: TextAttributes.NONE };
}

/**
 * Merge-conflict line; null unless GitHub reports the PR as conflicting. A
 * clean or still-computing (`unknown`) merge stays quiet to avoid noise.
 */
function mergeLine(status: Extract<GithubStatus, { kind: "pr" }>): Line | null {
  if (status.pr.mergeable !== "conflicting") return null;
  return { content: formatRow("✗ merge", "conflicts", TEXT_WIDTH), fg: COLOR_FAIL, attrs: TextAttributes.NONE };
}

/** Dedicated Bugbot line; null when no Bugbot check is attached to the PR. */
function bugbotLine(status: Extract<GithubStatus, { kind: "pr" }>, frame: string): Line | null {
  const bugbot = status.pr.bugbot;
  if (bugbot === undefined) return null;
  if (bugbot.state === "pending") {
    return { content: formatRow(`${frame} bugbot`, "running", TEXT_WIDTH), fg: COLOR_PENDING, attrs: TextAttributes.NONE };
  }
  if (bugbot.state === "error") {
    return { content: formatRow("✗ bugbot", "error", TEXT_WIDTH), fg: COLOR_FAIL, attrs: TextAttributes.NONE };
  }
  if (bugbot.state === "issues") {
    const detail = bugbot.unresolved === undefined ? "issues" : `${bugbot.unresolved} unresolved`;
    return { content: formatRow("● bugbot", detail, TEXT_WIDTH), fg: COLOR_BUGBOT_ISSUES, attrs: TextAttributes.NONE };
  }
  return { content: formatRow("✓ bugbot", "clean", TEXT_WIDTH), fg: COLOR_PASS, attrs: TextAttributes.NONE };
}

function buildLines(status: Extract<GithubStatus, { kind: "pr" }>, frame: string): Line[] {
  const lines: Line[] = [
    { content: formatRow(`#${status.pr.number}`, prStateLabel(status), TEXT_WIDTH), fg: prStateColor(status), attrs: TextAttributes.BOLD },
    { content: status.pr.title, fg: COLOR_TITLE, attrs: TextAttributes.NONE },
    ciLine(status, frame),
  ];
  const neutral = neutralLine(status);
  if (neutral !== null) lines.push(neutral);
  const merge = mergeLine(status);
  if (merge !== null) lines.push(merge);
  const bugbot = bugbotLine(status, frame);
  if (bugbot !== null) lines.push(bugbot);
  return lines;
}

function isLive(status: GithubStatus): boolean {
  return status.kind === "pr" && (status.pr.ciOverall === "pending" || status.pr.bugbot?.state === "pending");
}

export function createGithubStatusPanel(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const panel = new BoxRenderable(renderer, {
    id: "loop-github-status",
    width: LIST_WIDTH,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: "#45475a",
    title: "PR",
    titleAlignment: "left",
    paddingX: PANEL_PADDING_X,
    flexDirection: "column",
  });

  let nextRowId = 0;
  const rows: TextRenderable[] = [];

  const ensureRowCount = (count: number) => {
    while (rows.length > count) {
      const row = rows.pop()!;
      panel.remove(row.id);
      row.destroy();
    }
    while (rows.length < count) {
      const row = new TextRenderable(renderer, {
        id: `loop-github-row-${nextRowId++}`,
        width: "100%",
        height: 1,
        content: "",
        fg: COLOR_MUTED,
        truncate: true,
      });
      rows.push(row);
      panel.add(row);
    }
  };

  let frameIndex = 0;
  const update = () => {
    const status = state.github;
    // The panel only exists when there's a PR to show; for loading / no-pr /
    // error states it collapses out of layout entirely (yoga display:none via
    // `visible`), leaving the step list to fill the column.
    if (status.kind !== "pr") {
      if (panel.visible) panel.visible = false;
      ensureRowCount(0);
      renderer.requestRender();
      return;
    }
    if (!panel.visible) panel.visible = true;
    const frame = SPINNER[frameIndex % SPINNER.length]!;
    const lines = buildLines(status, frame);
    ensureRowCount(lines.length);
    lines.forEach((line, index) => {
      const row = rows[index];
      if (!row) return;
      row.content = line.content;
      row.fg = line.fg;
      row.attributes = line.attrs;
    });
    renderer.requestRender();
  };

  const unsubscribe = subscribe(update);
  const timer = setInterval(() => {
    frameIndex += 1;
    if (isLive(state.github)) update();
  }, 100);

  panel.on(RenderableEvents.DESTROYED, () => {
    clearInterval(timer);
    unsubscribe();
  });

  update();
  return panel;
}
