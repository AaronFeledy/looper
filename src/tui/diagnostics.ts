import type { CliRenderer } from "@opentui/core";
import { diagnosticsFor, setDiagnosticsVisible } from "../lib/tui-diagnostics.ts";
import type { LoopState } from "../lib/state.ts";
import { createTextDialog } from "./dialog.ts";
import { modalFocusWinner } from "./permission-gate.ts";

export function createDiagnosticsView(renderer: CliRenderer, state: LoopState) {
  const host = createTextDialog(renderer, state, {
    id: "loop-diagnostics", borderColor: "#f3bf7a", width: "90%", height: "80%", maxWidth: 140,
    isVisible: () => modalFocusWinner(state) === "diagnostics",
    content: () => {
      const log = diagnosticsFor(state);
      // Only acknowledge entries while the window actually owns visible focus.
      log.unread = 0;
      return {
        title: "Diagnostics · esc / l close · ↑↓ / PgUp / PgDn scroll",
        body: [
          ...(log.dropped ? [`${log.dropped} older entries discarded.\n`] : []),
          ...log.entries.map(entry => `[${new Date(entry.at).toLocaleTimeString()}] ${entry.level.toUpperCase()} · ${entry.source}${entry.count > 1 ? ` · repeated ${entry.count} times` : ""}\n${entry.message}`),
        ].join("\n\n") || "No runtime warnings or errors.",
      };
    },
  });
  const scrim = host.findDescendantById("loop-diagnostics-scrim");
  if (scrim) scrim.onMouseUp = event => {
    if (event.button === 0 && event.type === "up" && modalFocusWinner(state) === "diagnostics")
      setDiagnosticsVisible(state, false);
  };
  return host;
}
