import type { RequestBrokerScheduler } from "./request-broker-types.ts";

export const DEFAULT_GATE_MAX_MS = 1_800_000;
export const DEFAULT_CLAIM_POLL_MS = 50;
export const HANDLED_REQUEST_LIMIT = 1_000;
export const FRICTION_LIMIT = 3;

export class AlreadyResolvedRequestError extends Error {
  override readonly name = "AlreadyResolvedRequestError";
}

export function isAlreadyResolvedRequest(error: unknown): boolean {
  if (error instanceof AlreadyResolvedRequestError) return true;
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  const tag = error._tag;
  return tag === "PermissionNotFoundError" || tag === "QuestionNotFoundError";
}

export function createRequestBrokerScheduler(): RequestBrokerScheduler {
  const timeouts = new WeakMap<object, ReturnType<typeof setTimeout>>();
  const intervals = new WeakMap<object, ReturnType<typeof setInterval>>();
  return {
    setTimeout(callback, milliseconds) {
      const token = {};
      const handle = setTimeout(callback, milliseconds);
      handle.unref?.();
      timeouts.set(token, handle);
      return token;
    },
    clearTimeout(token) {
      const handle = timeouts.get(token);
      if (handle !== undefined) clearTimeout(handle);
      timeouts.delete(token);
    },
    setInterval(callback, milliseconds) {
      const token = {};
      const handle = setInterval(callback, milliseconds);
      handle.unref?.();
      intervals.set(token, handle);
      return token;
    },
    clearInterval(token) {
      const handle = intervals.get(token);
      if (handle !== undefined) clearInterval(handle);
      intervals.delete(token);
    },
  };
}
