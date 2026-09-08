import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireConfigDir, tolerantRm, writeFileAtomically } from "../lib/state-files.ts";
import { withFileTransaction } from "./file-transaction.ts";

/** Marks a request parsed from a plaintext (agent-written) marker file. */
const LEGACY_REQUEST_ID_PREFIX = "legacy-";

export type AdjudicationRequest = {
  readonly id: string;
  readonly reason: string;
};

export function parseAdjudicationRequest(value: unknown): AdjudicationRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("id" in value) || typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (!("reason" in value) || typeof value.reason !== "string") return undefined;
  return { id: value.id, reason: value.reason };
}

function markerPath(): string {
  return join(requireConfigDir(), ".looper-adjudicate");
}

export function readAdjudicationRequest(): AdjudicationRequest | null {
  let fd: number;
  try {
    fd = openSync(markerPath(), "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const content = readFileSync(fd, "utf8");
    try {
      const parsed: unknown = JSON.parse(content);
      const request = parseAdjudicationRequest(parsed);
      if (request !== undefined) return request;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    // Legacy agent-written plaintext markers still route, with identity tied to
    // the opened file version so a repeated reason need not mean the same request.
    const stat = fstatSync(fd, { bigint: true });
    const id = createHash("sha256").update(`${stat.ino}:${stat.mtimeNs}:${content}`).digest("hex");
    return { id: `${LEGACY_REQUEST_ID_PREFIX}${id}`, reason: content };
  } finally {
    closeSync(fd);
  }
}

export function writeAdjudicationRequest(reason: string): void {
  withFileTransaction(requireConfigDir(), () => {
    writeFileAtomically(markerPath(), JSON.stringify({ id: randomUUID(), reason }));
  });
}

export function clearAdjudicationRequest(): void {
  withFileTransaction(requireConfigDir(), () => tolerantRm(markerPath()));
}

export function isAgentWrittenRequest(request: AdjudicationRequest): boolean {
  return request.id.startsWith(LEGACY_REQUEST_ID_PREFIX);
}

// Caller owns the transaction, allowing completion-log/watermark writes to finish
// before this compare-and-remove; writers of new requests use the same mutex.
//
// Removes the consumed request. A DIFFERENT request that appeared while the
// adjudicator ran is only dropped when it is agent-written (plaintext): that is
// the adjudicator's own artifact, and honoring it would re-route into an endless
// adjudication loop. An identified request (`looper signal adjudicate`, or
// detection) is left in place so a genuinely new signal is never swallowed by an
// older adjudication.
export function acknowledgeAdjudicationRequest(request: AdjudicationRequest): void {
  const pending = readAdjudicationRequest();
  if (pending === null) return;
  if (pending.id === request.id || isAgentWrittenRequest(pending)) tolerantRm(markerPath());
}
