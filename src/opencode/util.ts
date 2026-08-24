const CONTINUATION_LOG_FIELD_MAX = 200;

export function formatRequestError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  if (error === undefined) return "unknown error";
  return JSON.stringify(error);
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

/**
 * Abort the signal passed to `event.subscribe`. The OpenCode SSE client calls
 * `reader.cancel()` from its abort listener and does not await it; that
 * rejection surfaces as an unhandled `The operation was aborted`.
 */
export function abortSubscribeSignal(controller: AbortController | undefined): void {
  if (controller === undefined || controller.signal.aborted) return;
  const proto = ReadableStreamDefaultReader.prototype;
  const original = proto.cancel;
  proto.cancel = function (this: ReadableStreamDefaultReader, reason?: unknown): Promise<void> {
    return original.call(this, reason).catch((error: unknown) => {
      if (error instanceof Error && isAbortError(error)) return;
      throw error;
    });
  };
  try {
    controller.abort();
  } finally {
    proto.cancel = original;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function sanitizeLogField(value: string): string {
  return value
    .replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, CONTINUATION_LOG_FIELD_MAX);
}
