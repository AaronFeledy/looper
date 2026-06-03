import { BoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";

// Catppuccin Mocha accents, matching the rest of the TUI (header/footer/step-list).
const COLOR_TITLE = "#8bd5ff";
const COLOR_ACTIVE = "#f9e2af";
const COLOR_DONE = "#a6e3a1";
const COLOR_BORDER = "#45475a";

const ICON_ACTIVE = "▶";
const ICON_DONE = "✓";

type PhaseStatus = "active" | "done";

interface Phase {
  label: string;
  status: PhaseStatus;
  text: TextRenderable;
}

export interface BootScreen {
  /** Mark the previous phase done and add a new active phase row. */
  begin(label: string): void;
  done(): void;
  destroy(): void;
}

function phaseLine(phase: Phase): string {
  const icon = phase.status === "done" ? ICON_DONE : ICON_ACTIVE;
  return `${icon} ${phase.label}`;
}

function phaseColor(status: PhaseStatus): string {
  return status === "done" ? COLOR_DONE : COLOR_ACTIVE;
}

/**
 * Renders a small centered status panel so the screen is never blank while the
 * slow startup awaits (branch watcher, config load, opencode start/attach,
 * client creation, managed-resource validation) are in flight. It is removed
 * before the real UI root is mounted.
 */
export function createBootScreen(renderer: CliRenderer): BootScreen {
  const container = new BoxRenderable(renderer, {
    id: "looper-boot",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    padding: 1,
  });

  const panel = new BoxRenderable(renderer, {
    id: "looper-boot-panel",
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: COLOR_BORDER,
    title: "Looper",
    paddingX: 2,
    paddingY: 1,
    minWidth: 40,
  });

  const heading = new TextRenderable(renderer, {
    id: "looper-boot-heading",
    content: "Starting up…",
    fg: COLOR_TITLE,
    attributes: TextAttributes.BOLD,
    truncate: true,
  });
  panel.add(heading);

  const phasesBox = new BoxRenderable(renderer, {
    id: "looper-boot-phases",
    flexDirection: "column",
    paddingTop: 1,
  });
  panel.add(phasesBox);

  container.add(panel);
  renderer.root.add(container);
  renderer.requestRender();

  const phases: Phase[] = [];
  let nextPhaseId = 0;
  let destroyed = false;

  const completeActive = () => {
    const current = phases[phases.length - 1];
    if (current === undefined || current.status === "done") return;
    current.status = "done";
    current.text.content = phaseLine(current);
    current.text.fg = phaseColor(current.status);
  };

  return {
    begin(label: string) {
      if (destroyed) return;
      completeActive();
      const text = new TextRenderable(renderer, {
        id: `looper-boot-phase-${nextPhaseId++}`,
        content: "",
        fg: COLOR_ACTIVE,
        truncate: true,
      });
      const phase: Phase = { label, status: "active", text };
      text.content = phaseLine(phase);
      text.fg = phaseColor(phase.status);
      phases.push(phase);
      phasesBox.add(text);
      renderer.requestRender();
    },
    done() {
      if (destroyed) return;
      completeActive();
      renderer.requestRender();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      renderer.root.remove(container.id);
      container.destroy();
      renderer.requestRender();
    },
  };
}
