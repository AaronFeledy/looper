import { BoxRenderable, RenderableEvents, TextRenderable, type CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { subscribe } from "../lib/state.ts";
import { queueSummaryLine } from "./permission-gate.ts";
import { truncateDisplay } from "./text-layout.ts";

const QUESTION_TEXT_MAX_WIDTH = 100;

function firstQuestionText(questions: readonly unknown[]): string | undefined {
  const first = questions[0];
  if (typeof first !== "object" || first === null) return undefined;
  const record = first as Record<string, unknown>;
  const text = typeof record.question === "string" ? record.question : typeof record.header === "string" ? record.header : undefined;
  if (text === undefined || text.length === 0) return undefined;
  return truncateDisplay(text, QUESTION_TEXT_MAX_WIDTH);
}

export function pendingRequestLines(state: LoopState): string[] {
  const lines: string[] = [];
  for (const request of state.pendingRequests) {
    if (request.kind === "permission") {
      const patterns = request.patterns.length > 0 ? ` — ${request.patterns.join(", ")}` : "";
      lines.push(`Agent is waiting on permission '${request.permission}'${patterns}`);
      lines.push(`[y] once  [a] always  [d] deny  [s] deny + skip  -  or an attached opencode client / permissionPolicy.${request.permission}`);
    } else {
      const text = firstQuestionText(request.questions);
      lines.push(text === undefined ? "Agent asked a question" : `Agent asked: ${text}`);
      lines.push("[d] reject  [s] skip  -  richer answers need an attached opencode client / questionPolicy: reject");
    }
  }
  const summary = queueSummaryLine(state.pendingRequests.length);
  if (summary !== null) lines.push(summary);
  return lines;
}

export function createPendingRequestPanel(renderer: CliRenderer, state: LoopState): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    id: "loop-pending-request",
    width: "100%",
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: "#f9e2af",
    title: "waiting on you",
    titleAlignment: "left",
    paddingX: 1,
    marginBottom: 1,
    flexShrink: 0,
    visible: false,
  });

  const text = new TextRenderable(renderer, {
    id: "loop-pending-request-text",
    width: "100%",
    content: "",
    fg: "#f9e2af",
    wrapMode: "word",
  });
  box.add(text);

  const apply = (): void => {
    const lines = pendingRequestLines(state);
    if (lines.length === 0) {
      box.visible = false;
      text.content = "";
    } else {
      text.content = lines.join("\n");
      box.visible = true;
    }
    renderer.requestRender();
  };

  apply();
  const unsubscribe = subscribe(apply);
  box.on(RenderableEvents.DESTROYED, () => {
    unsubscribe();
  });

  return box;
}
