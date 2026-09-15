import { Database } from "bun:sqlite";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

// SQLite's OS locks serialize JSON read/modify/replace across processes and are
// released on process death. Never unlink this mutex file, including on --fresh.
export function withFileTransaction<T>(configDir: string, operation: () => T): T {
  const path = join(configDir, ".looper-state-lock.sqlite");
  closeSync(openSync(path, "a", 0o600));
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db.transaction(operation).immediate();
  } finally {
    db.close();
  }
}
