const OMO_INTERNAL_MARKER_DETECT = /<!--\s*OMO_INTERNAL_(?:INITIATOR|NOREPLY)\s*-->/;
const OMO_INTERNAL_MARKER_STRIP = /\n*<!--\s*OMO_INTERNAL_(?:INITIATOR|NOREPLY)\s*-->\s*/g;

export function stripOmoInternalMarkers(text: string): string {
  return text.replace(OMO_INTERNAL_MARKER_STRIP, "").trimEnd();
}

export function isOmoInternalOnlyText(text: string): boolean {
  if (!OMO_INTERNAL_MARKER_DETECT.test(text)) return false;
  return stripOmoInternalMarkers(text).trim().length === 0;
}

export function textPartsOf(parts: readonly { type?: string; text?: string }[]): string[] {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
}

/** True when a user message is only OMO control markers (no visible prompt body). */
export function isOmoInternalOnlyUserMessage(entry: {
  info?: { role?: string };
  role?: string;
  parts?: readonly { type?: string; text?: string }[];
}): boolean {
  const role = entry.info?.role ?? entry.role;
  if (role !== "user") return false;
  const texts = textPartsOf(entry.parts ?? []);
  return texts.length > 0 && texts.every((text) => isOmoInternalOnlyText(text));
}

function isIncompleteAssistantEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || !("info" in entry)) return false;
  const info = (entry as { info?: { role?: string; time?: { completed?: number } } }).info;
  if (info?.role !== "assistant") return false;
  return info.time?.completed === undefined;
}

/**
 * Session message order puts trailing OMO control user turns after earlier assistant
 * messages. When those assistants are still open (no time.completed), backfill then
 * keeps growing content *above* the OMO block. Move open assistants after trailing
 * OMO-only user turns so live work stays at the bottom while control turns stay visible.
 */
export function orderMessagesForRender<T>(messages: readonly T[]): T[] {
  if (messages.length === 0) return [];

  const trailingOmo: T[] = [];
  let end = messages.length;
  while (end > 0 && isOmoInternalOnlyUserMessage(messages[end - 1] as object)) {
    trailingOmo.unshift(messages[end - 1]!);
    end -= 1;
  }
  if (trailingOmo.length === 0) return [...messages];

  const head: T[] = messages.slice(0, end);
  const incomplete: T[] = [];
  while (head.length > 0 && isIncompleteAssistantEntry(head[head.length - 1])) {
    incomplete.unshift(head.pop()!);
  }

  if (incomplete.length === 0) return [...messages];
  return [...head, ...trailingOmo, ...incomplete];
}
