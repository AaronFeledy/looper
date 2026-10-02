import { Database } from "bun:sqlite";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { UsageError } from "../lib/args.ts";
import { tolerantRead, writeFileAtomically } from "../lib/state-files.ts";
import { isRecord } from "../opencode/util.ts";

export type RunLease = Disposable & { readonly assertOwned: () => void };

export function acquireRunLease(configDir: string): RunLease {
  const path = join(configDir, ".looper-run-lock.sqlite");
  closeSync(openSync(path, "a", 0o600));
  const db = new Database(path);
  const ownerPath = join(configDir, ".looper-run-owner.json");
  const ownerText = JSON.stringify({ version: 1, pid: process.pid, host: hostname(), token: crypto.randomUUID() });
  let held = true;
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const raw = tolerantRead(ownerPath);
    if (raw !== null) {
      const owner: unknown = JSON.parse(raw);
      if (!isRecord(owner) || owner.version !== 1 || owner.host !== hostname()
        || typeof owner.token !== "string" || owner.token.trim().length === 0
        || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
        throw new UsageError(`Unknown frontend ownership in ${ownerPath}; reconcile that frontend before retrying`);
      }
      let alive = true;
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if (isRecord(error) && error.code === "ESRCH") alive = false;
        else throw error;
      }
      if (alive) throw new UsageError(`Recorded frontend PID ${owner.pid} is still alive; stop it before retrying (shutdown acknowledgment cannot override a live owner)`);
    }
    writeFileAtomically(ownerPath, ownerText);
  } catch (error) {
    db.close();
    if (error instanceof Error) throw new UsageError(`Cannot acquire run ownership (another Looper may be running): ${error.message}`);
    throw error;
  }
  return {
    assertOwned() {
      if (!held || tolerantRead(ownerPath) !== ownerText) throw new UsageError("Frontend ownership changed; refusing state mutation. Stop other frontends and restart Looper");
    },
    [Symbol.dispose]() {
      held = false;
      try { if (tolerantRead(ownerPath) === ownerText) unlinkSync(ownerPath); }
      finally { db.close(); }
    },
  };
}
