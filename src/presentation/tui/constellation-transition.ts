import type { BubblePlacement, ConstellationScene } from "./constellation.ts";

export const HANDOFF_DURATION_MS = 760;
const emphasis = (bubble: BubblePlacement) => bubble.prominence ?? (bubble.node.lane === "live" ? 1 : 0);
const geometry = (scene: ConstellationScene) => JSON.stringify([scene.bubbles.map((b) => [b.node.id, b.x, b.y, b.width, b.height, b.region, b.compact]), scene.loopMarker]);
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;

/** Render-only positions. Retarget from the visible frame when events arrive mid-handoff. */
export function createConstellationTransition() {
  let target: ConstellationScene | undefined;
  let source: ConstellationScene | undefined;
  let targetKey = "";
  let startedAt = 0;
  let scope: unknown;

  const render = (now: number): ConstellationScene => {
    if (!target) throw new Error("Constellation transition has no scene");
    if (!source) return target;
    const t = Math.max(0, Math.min(1, (now - startedAt) / HANDOFF_DURATION_MS));
    if (t === 1) { source = undefined; return target; }
    const p = t * t * (3 - 2 * t);
    const previous = new Map(source.bubbles.map((bubble) => [bubble.node.id, bubble]));
    const next = new Map(target.bubbles.map(bubble => [bubble.node.id, bubble]));
    // Fold/unfold at the nearest visible ancestor. In a sidebar this is a
    // vertical drawer; on stage cards shrink toward the parent's bottom row.
    const anchor = (bubble: BubblePlacement, scene: ConstellationScene): BubblePlacement | undefined => {
      let parentID = bubble.node.parentID;
      const seen = new Set<string>();
      while (parentID && !seen.has(parentID)) {
        seen.add(parentID);
        const parent = scene.bubbles.find(item => item.node.id === parentID);
        if (parent) return {
          ...bubble, x: bubble.node.lane === "live" ? parent.x + Math.floor(parent.width / 2) - 1 : bubble.x,
          y: parent.y + parent.height - 2,
          width: bubble.node.lane === "live" ? 3 : bubble.width,
          height: 1, prominence: 0, compact: true, region: parent.region,
        };
        parentID = (previous.get(parentID) ?? next.get(parentID))?.node.parentID;
      }
      return undefined;
    };
    const interpolate = (from: BubblePlacement, bubble: BubblePlacement): BubblePlacement => {
      const width = Math.round(lerp(from.width, bubble.width, p));
      return {
        ...bubble,
        x: Math.max(0, Math.min(target!.width - width, Math.round(lerp(from.x, bubble.x, p)))),
        y: Math.round(lerp(from.y, bubble.y, p)),
        width, height: Math.round(lerp(from.height, bubble.height, p)),
        prominence: lerp(emphasis(from), emphasis(bubble), p),
        traveling: from.traveling || from.region !== bubble.region,
      };
    };
    const bubbles = target.bubbles.map((bubble) => {
      const from = previous.get(bubble.node.id) ?? anchor(bubble, source!);
      return from ? interpolate(from, bubble) : bubble;
    });
    for (const bubble of source.bubbles) {
      if (next.has(bubble.node.id) || !bubble.node.parentID) continue;
      const folded = anchor(bubble, target);
      if (folded) bubbles.push(interpolate(bubble, folded));
    }
    const labelKey = (text: string) => text.split(" · ")[0];
    const labels = target.labels.map((label, i) => {
      const from = i === 0 ? source!.labels[0] : source!.labels.find((candidate) => labelKey(candidate.text) === labelKey(label.text));
      return from ? { ...label, x: Math.round(lerp(from.x, label.x, p)), y: Math.round(lerp(from.y, label.y, p)) } : label;
    });
    const marker = target.loopMarker, priorMarker = source.loopMarker;
    const loopMarker = marker && priorMarker?.iteration === marker.iteration ? {
      ...marker, x: Math.round(lerp(priorMarker.x, marker.x, p)), y: Math.round(lerp(priorMarker.y, marker.y, p)),
      traveling: priorMarker.traveling || priorMarker.region !== marker.region,
    } : marker;
    return { ...target, bubbles, labels, ...(loopMarker ? { loopMarker } : {}), height: Math.max(source.height, target.height) };
  };

  return {
    sample(scene: ConstellationScene, now: number, options: { animate: boolean; scope: unknown }): ConstellationScene {
      const key = geometry(scene);
      if (!target || !options.animate || scope !== options.scope || target.width !== scene.width) {
        target = scene; source = undefined; targetKey = key; scope = options.scope;
        return scene;
      }
      if (key !== targetKey) {
        source = render(now);
        startedAt = now;
        targetKey = key;
      }
      target = scene; // Activity, selection and labels stay current without restarting movement.
      return render(now);
    },
    isTransitioning(): boolean {
      return source !== undefined;
    },
  };
}
