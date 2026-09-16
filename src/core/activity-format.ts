export function compactActivity(text: string, words = 7): string {
  const clean = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/[\x60*_#]/g, "").replace(/\s+/g, " ").trim();
  const parts = clean.split(" ");
  return (parts.length > words ? parts.slice(0, words).join(" ") + "…" : clean).slice(0, 100);
}
export function inputText(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof input[key] === "string") return (input[key] as string).slice(0, 8_000);
  return "";
}
export function basename(path: string): string {
  return path.trim().split(/[\\/]/).pop() ?? "";
}
