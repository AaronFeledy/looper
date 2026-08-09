import type { BoxRenderable, CliRenderer } from "@opentui/core";

import type { LoopState } from "../lib/state.ts";
import { createTextDialog } from "./dialog.ts";
import { gateModalContent, modalFocusWinner } from "./permission-gate.ts";

/** Above help/prompt/config dialogs, matching the gate's key precedence. */
const GATE_Z_INDEX = 300;

export function createPermissionDialog(renderer: CliRenderer, state: LoopState): BoxRenderable {
  return createTextDialog(renderer, state, {
    id: "loop-permission-gate",
    borderColor: "#f9e2af",
    zIndex: GATE_Z_INDEX,
    width: "95%",
    maxWidth: 88,
    scroll: false,
    isVisible: (current) => modalFocusWinner(current) === "permission",
    content: (current) => gateModalContent(current.pendingRequests) ?? { title: "waiting on you", body: "" },
  });
}
