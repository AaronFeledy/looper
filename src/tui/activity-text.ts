/** Shared moving gradient for bubbles and the fixed activity row in full output. */
export function flowingActivityText(text: string, phase: number): string {
  const from = [122, 186, 194], to = [216, 209, 250];
  return [...text].map((char, i) => {
    const glow = (1 - Math.cos(i / 8 - phase)) / 2;
    const color = from.map((value, index) => Math.round(value + (to[index]! - value) * glow));
    return `\x1b[38;2;${color.join(";")}m${char}`;
  }).join("") + "\x1b[0m";
}
