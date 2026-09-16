import { $ } from "bun";
import { openUrl } from "./open-url.ts";

/** Session IDs are opaque path-free identifiers, not arbitrary opener arguments. */
export function opencodeSessionUrl(sessionID: string | undefined): string | undefined {
  return sessionID && /^ses_[A-Za-z0-9_-]+$/.test(sessionID) ? `opencode://${sessionID}` : undefined;
}

export async function openOpencodeSession(sessionID: string): Promise<void> {
  const url = opencodeSessionUrl(sessionID);
  if (!url) throw new Error("Invalid OpenCode session ID");
  if (process.platform === "linux" && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) {
    // Looper runs in WSL, while the desktop protocol handler lives on Windows.
    // The validated URL contains no quotes or shell metacharacters.
    await $`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command ${"Start-Process -FilePath '" + url + "' -ErrorAction Stop"}`.quiet();
    return;
  }
  await openUrl(url);
}
