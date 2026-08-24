import type { CliRenderer } from "@opentui/core";

export type SelectionCopyMouseEvent = {
  readonly button: number;
  preventDefault(): void;
  stopPropagation(): void;
};

export type SelectionCopyHost = {
  readonly getSelection: () => { getSelectedText(): string } | null;
  readonly copyToClipboardOSC52: (text: string) => boolean;
  readonly clearSelection: () => void;
};

const RIGHT_BUTTON = 2;

export function copySelectionIfAny(renderer: SelectionCopyHost): boolean {
  const selectedText = renderer.getSelection()?.getSelectedText() ?? "";
  if (selectedText.length === 0) return false;
  renderer.copyToClipboardOSC52(selectedText);
  renderer.clearSelection();
  return true;
}

export function handleSelectionCopyClick(renderer: SelectionCopyHost, event: SelectionCopyMouseEvent): void {
  if (event.button !== RIGHT_BUTTON) return;
  if (!copySelectionIfAny(renderer)) return;
  event.preventDefault();
  event.stopPropagation();
}

export function bindRightClickCopy(renderer: CliRenderer): () => void {
  const root = renderer.root;
  if (root === undefined) return () => {};

  const handleMouseDown = (event: SelectionCopyMouseEvent): void => {
    handleSelectionCopyClick(renderer, event);
  };
  root.onMouseDown = handleMouseDown;
  return () => {
    root.onMouseDown = undefined;
  };
}
