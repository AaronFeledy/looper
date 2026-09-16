import { BoxRenderable, LayoutEvents, RenderableEvents, ScrollBoxRenderable, TextAttributes, TextRenderable, t, link, fg, underline, type CliRenderer } from "@opentui/core";
import { closeAgentInspector, INSPECTOR_TABS, selectInspectorTab, selectedInspectorTarget } from "../lib/agent-inspector-state.ts";
import { sanitizeTerminalText } from "../lib/ansi.ts";
import { subscribe, type LoopState } from "../lib/state.ts";
import { inspectorContext, inspectorDetailLines, inspectorMetadataLine, inspectorPrompt, inspectorTitle } from "../presentation/tui/agent-inspector.ts";
import { createDialogFrame } from "./dialog.ts";
import { opencodeSessionUrl, openOpencodeSession } from "../lib/opencode-session-link.ts";
import { modalFocusWinner } from "./permission-gate.ts";

/** One transcript renderable moves between history and the modal; no duplicate output consumers. */
export function createAgentInspector(
  renderer: CliRenderer, state: LoopState, stream: ScrollBoxRenderable, historyHost: BoxRenderable,
  options: { openSession?: (sessionID: string) => Promise<void> } = {},
): BoxRenderable {
  const { host, scrim, dialog } = createDialogFrame(renderer, {
    id: "agent-inspector", borderColor: "#b7a3ef", zIndex: 100,
  });
  const header = new BoxRenderable(renderer, { id: "agent-inspector-header", width: "100%", height: 1, flexShrink: 0, flexDirection: "row" });
  const title = new TextRenderable(renderer, { id: "agent-inspector-title", flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, height: 1, fg: "#e1eeef", attributes: TextAttributes.BOLD, truncate: true, content: "" });
  const close = new TextRenderable(renderer, { id: "agent-inspector-close", width: 9, flexShrink: 0, height: 1, content: "[× close]", fg: "#b7a3ef", selectable: false,
    onMouseUp(event) { if (event.type === "up" && event.button === 0 && modalFocusWinner(state) === "inspector") closeAgentInspector(state); } });
  header.add(title); header.add(close);
  const metadata = new TextRenderable(renderer, { id: "agent-inspector-metadata", width: "100%", height: 2, flexShrink: 0, fg: "#91d9df", wrapMode: "word", content: "" });
  const tabs = new BoxRenderable(renderer, { id: "agent-inspector-tabs", width: "100%", height: 1, flexShrink: 0, flexDirection: "row" });
  const tabLabels = INSPECTOR_TABS.map((tab, i) => {
    const label = new TextRenderable(renderer, { id: `agent-inspector-tab-${tab}`, height: 1, flexGrow: 1, flexBasis: 0, minWidth: 0, truncate: true, selectable: false,
      content: `${i + 1} ${tab[0]!.toUpperCase()}${tab.slice(1)}`,
      onMouseUp(event) { if (event.type === "up" && event.button === 0 && modalFocusWinner(state) === "inspector") selectInspectorTab(state, tab); } });
    tabs.add(label);
    return label;
  });
  const output = new BoxRenderable(renderer, { id: "agent-inspector-output", width: "100%", flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, flexDirection: "column" });
  output.add(stream);
  const textPane = new ScrollBoxRenderable(renderer, {
    id: "agent-inspector-text-pane", width: "100%", flexGrow: 1, minHeight: 0, paddingRight: 1, scrollY: true, scrollX: false,
    contentOptions: { width: "100%", minHeight: "auto" },
  });
  const text = new TextRenderable(renderer, { id: "agent-inspector-text", width: "100%", fg: "#cdd6f4", wrapMode: "word", content: "" });
  textPane.add(text);
  const details = new BoxRenderable(renderer, { id: "agent-inspector-details", width: "100%", flexDirection: "column", visible: false });
  const detailRows: TextRenderable[] = [];
  let sessionID: string | undefined;
  let openError = "";
  let opening = false;
  textPane.add(details);
  const footer = new TextRenderable(renderer, { id: "agent-inspector-footer", width: "100%", height: 1, flexShrink: 0, truncate: true, fg: "#a6adc8", content: "" });
  dialog.add(header); dialog.add(metadata); dialog.add(tabs); dialog.add(output); dialog.add(textPane); dialog.add(footer);
  scrim.onMouseUp = (event) => {
    if (event.type === "up" && event.button === 0 && modalFocusWinner(state) === "inspector") closeAgentInspector(state);
  };
  // Integer cell dimensions and even margins avoid fractional Yoga rounding that
  // can otherwise paint the transcript's bottom border over the footer.
  const fitDialog = (): void => {
    const width = Math.min(historyHost.width > 1 ? historyHost.width : renderer.width, renderer.width);
    const height = Math.min(historyHost.height > 1 ? historyHost.height : renderer.height, renderer.height);
    let panelWidth = Math.max(1, Math.min(150, width - 2 * Math.max(1, Math.round(width * 0.03))));
    if ((width - panelWidth) % 2 && panelWidth > 1) panelWidth--;
    dialog.width = panelWidth;
    dialog.height = Math.max(1, height - 2 * Math.max(1, Math.round(height * 0.04)));
    renderer.requestRender();
  };
  fitDialog();
  host.on(LayoutEvents.RESIZED, fitDialog);
  renderer.on("resize", fitDialog);
  let applyingScroll = false;
  let lastBody = "";
  const update = (): void => {
    fitDialog();
    const history = state.historyView !== null;
    const shown = !history && modalFocusWinner(state) === "inspector";
    const tab = state.constellation?.inspectorTab ?? "output";
    host.visible = shown;
    const parent = history ? historyHost : output;
    if (stream.parent !== parent) { stream.parent?.remove(stream); parent.add(stream); }
    stream.visible = history || (shown && tab === "output");
    stream.width = "100%"; stream.height = history ? "100%" : "auto"; stream.minHeight = 0; stream.flexGrow = 1; stream.flexShrink = 1;
    output.visible = shown && tab === "output";
    textPane.visible = shown && tab !== "output";
    if (!shown) return;
    title.content = sanitizeTerminalText(inspectorTitle(state));
    metadata.content = sanitizeTerminalText(inspectorMetadataLine(state));
    details.visible = tab === "details";
    text.visible = tab !== "details";
    if (tab === "details") {
      const target = selectedInspectorTarget(state);
      const nextID = (target?.agent ?? target?.step)?.sessionID;
      if (nextID !== sessionID) { sessionID = nextID; openError = ""; }
      const lines = inspectorDetailLines(state);
      while (detailRows.length > lines.length) { const row = detailRows.pop()!; details.remove(row); row.destroy(); }
      lines.forEach((line, i) => {
        let row = detailRows[i];
        if (!row) {
          row = new TextRenderable(renderer, { id: i === 4 ? "agent-inspector-session-link" : `agent-inspector-detail-${i}`, width: "100%", minHeight: 1, fg: "#cdd6f4", wrapMode: "word", content: "" });
          if (i === 4) row.onMouseUp = (event) => {
            if (event.type !== "up" || event.button !== 0 || modalFocusWinner(state) !== "inspector" || state.constellation?.inspectorTab !== "details" || !sessionID || !opencodeSessionUrl(sessionID) || opening) return;
            event.stopPropagation();
            const clickedID = sessionID;
            opening = true; openError = "";
            void (options.openSession ?? openOpencodeSession)(clickedID).catch(() => {
              if (!host.isDestroyed && sessionID === clickedID) openError = "Could not open OpenCode Desktop";
            }).finally(() => { opening = false; if (!host.isDestroyed) update(); });
          };
          details.add(row); detailRows.push(row);
        }
        const url = i === 4 ? opencodeSessionUrl(sessionID) : undefined;
        row.content = url ? t`Session: ${link(url)(fg("#91d9df")(underline(sessionID!)))}` : sanitizeTerminalText(line);
      });
    }
    const body = sanitizeTerminalText(tab === "prompt" ? inspectorPrompt(state) : tab === "context" ? inspectorContext(state) : "");
    if (body !== lastBody) { text.content = body; lastBody = body; }
    if (state.constellation) state.constellation.inspectorPageRows = Math.max(1, textPane.viewport.height - 1);
    applyingScroll = true;
    textPane.scrollTop = state.constellation?.inspectorScroll ?? 0;
    if (state.constellation) state.constellation.inspectorScroll = textPane.scrollTop;
    applyingScroll = false;
    tabLabels.forEach((label, i) => {
      const selected = INSPECTOR_TABS[i] === tab;
      label.fg = selected ? "#dfd3ff" : "#8c9baa";
      label.bg = selected ? "#37334d" : "transparent";
      label.attributes = selected ? TextAttributes.BOLD : TextAttributes.NONE;
    });
    footer.content = tab === "details" && openError ? openError : tab === "details" && opencodeSessionUrl(sessionID) ? "click session ID to open OpenCode · esc close · ↑↓ scroll" : tab === "context" ? "esc close · tab switch · ↑↓ scroll · b open PR · c config"
      : "esc close · tab switch · ↑↓/pgup/pgdn scroll · c config";
    renderer.requestRender();
  };
  textPane.verticalScrollBar.on("change", () => {
    if (!applyingScroll && state.constellation && textPane.visible) state.constellation.inspectorScroll = textPane.scrollTop;
  });
  const unsubscribe = subscribe(update);
  host.on(RenderableEvents.DESTROYED, () => { unsubscribe(); host.off(LayoutEvents.RESIZED, fitDialog); renderer.off("resize", fitDialog); });
  update();
  return host;
}
