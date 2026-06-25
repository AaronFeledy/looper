import { $ } from "bun";

/**
 * Open `url` in the user's default browser using the platform opener.
 * Linux: `xdg-open`; macOS: `open`; Windows: `cmd /c start`.
 */
export async function openUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  if (trimmed.length === 0) return;

  if (process.platform === "darwin") {
    await $`open ${trimmed}`.quiet();
    return;
  }
  if (process.platform === "win32") {
    await $`cmd /c start "" ${trimmed}`.quiet();
    return;
  }
  await $`xdg-open ${trimmed}`.quiet();
}