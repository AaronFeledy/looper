import type { BubblePlacement, ConstellationScene } from "./constellation.ts";

export type Point = { x: number; y: number };
export type WirePath = { points: Point[]; active: boolean; flow: boolean };
export type WireCache = { geometry: string; paths: WirePath[] };

function avoidBubbles(scene: ConstellationScene, points: Point[]): Point[] {
  const occupied = new Set<number>();
  for (const box of scene.bubbles) for (let y = box.y; y < box.y + box.height; y++)
    for (let x = box.x; x < box.x + box.width; x++) occupied.add(y * scene.width + x);
  if (points.every((p) => !occupied.has(p.y * scene.width + p.x))) return points;
  const start = points[0]!, end = points.at(-1)!;
  const size = scene.width * scene.height;
  const index = (p: Point) => p.y * scene.width + p.x;
  const source = index(start), target = index(end);
  if (source < 0 || source >= size || target < 0 || target >= size || occupied.has(source) || occupied.has(target)) return [];
  const previous = new Int32Array(size).fill(-1);
  const queue = [source];
  previous[source] = source;
  for (let head = 0; head < queue.length && previous[target] === -1; head++) {
    const at = queue[head]!, x = at % scene.width, y = Math.floor(at / scene.width);
    const neighbors = [
      { x: x + Math.sign(end.x - x || 1), y }, { x, y: y + Math.sign(end.y - y || 1) },
      { x: x - Math.sign(end.x - x || 1), y }, { x, y: y - Math.sign(end.y - y || 1) },
    ];
    for (const point of neighbors) {
      if (point.x < 0 || point.x >= scene.width || point.y < 0 || point.y >= scene.height) continue;
      const next = index(point);
      if (previous[next] !== -1 || occupied.has(next)) continue;
      previous[next] = at;
      queue.push(next);
    }
  }
  if (previous[target] === -1) return [];
  const path: Point[] = [];
  for (let at = target; ; at = previous[at]!) {
    path.push({ x: at % scene.width, y: Math.floor(at / scene.width) });
    if (at === source) break;
  }
  return path.reverse();
}

/** Expand orthogonal bends into terminal cells. */
function expand(bends: Point[]): Point[] {
  const points = [bends[0]!];
  for (const target of bends.slice(1)) {
    let current = points.at(-1)!;
    while (current.x !== target.x || current.y !== target.y) {
      current = { x: current.x + Math.sign(target.x - current.x), y: current.y + Math.sign(target.y - current.y) };
      points.push(current);
    }
  }
  return points;
}

function siblingPath(scene: ConstellationScene, parent: BubblePlacement, child: BubblePlacement, siblings: BubblePlacement[]): Point[] | undefined {
  const start = { x: parent.x + Math.floor(parent.width / 2), y: parent.y + parent.height };
  const end = { x: child.x + Math.floor(child.width / 2), y: child.y - 1 };
  const lastTap = Math.max(...siblings.map(box => box.y - 2));
  if (lastTap < start.y) return undefined;
  const blocked = (x: number, top: number, bottom: number) => scene.bubbles.some(box =>
    x >= box.x && x < box.x + box.width && top < box.y + box.height && bottom >= box.y);
  let spine = start.x;
  if (blocked(spine, start.y, lastTap)) {
    // Reserve an outer trunk for a narrow list or nested sibling families.
    // Include grandchildren when choosing it; never cut through a subtree.
    const familyIDs = new Set(siblings.map(box => box.node.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const box of scene.bubbles) if (box.node.parentID && familyIDs.has(box.node.parentID) && !familyIDs.has(box.node.id)) {
        familyIDs.add(box.node.id); changed = true;
      }
    }
    spine = Math.min(...scene.bubbles.filter(box => familyIDs.has(box.node.id) && !box.compact).map(box => box.x)) - 2;
    if (spine < 0 || blocked(spine, start.y, lastTap)) return undefined;
  }
  const tap = child.y - 2;
  // If the first branch shares the parent's exit row, join it directly.
  // Going out to the trunk and back would retrace the same cells.
  const points = expand(tap === start.y
    ? [start, { x: end.x, y: tap }, end]
    : [start, { x: spine, y: start.y }, { x: spine, y: tap }, { x: end.x, y: tap }, end]);
  // During handoffs the reserved corridors may temporarily be occupied.
  // Let the obstacle-aware fallback handle those frames.
  if (points.some(point => point.x < 0 || point.x >= scene.width || point.y < 0 || point.y >= scene.height ||
    blocked(point.x, point.y, point.y))) return undefined;
  return points;
}

export function routeConstellationLinks(scene: ConstellationScene, cache: WireCache): WirePath[] {
  const geometry = JSON.stringify([scene.width, scene.height, scene.bubbles.map((b) =>
    [b.node.id, b.node.parentID, b.node.lane, b.node.status, b.compact, b.x, b.y, b.width, b.height])]);
  if (geometry === cache.geometry) return cache.paths;
  const byID = new Map(scene.bubbles.map((bubble) => [bubble.node.id, bubble]));
  const roots = scene.bubbles.filter((bubble) => !bubble.node.parentID && bubble.node.previewIteration === undefined).sort((a, b) => a.node.stepIndex - b.node.stepIndex);
  const edges = scene.bubbles.flatMap((child) => {
    const parent = child.node.parentID ? byID.get(child.node.parentID) : undefined;
    return parent && child.node.lane === "live" && !child.compact ? [{ parent, child, active: child.node.status !== "idle", flow: false }] : [];
  });
  roots.slice(1).forEach((child, i) => edges.unshift({ parent: roots[i]!, child, active: false, flow: roots[i]!.x < child.x && roots[i]!.node.lane !== child.node.lane }));
  const previews = scene.bubbles.filter(bubble => bubble.node.previewIteration !== undefined);
  previews.slice(1).forEach((child, i) => edges.push({ parent: previews[i]!, child, active: false, flow: false }));
  // Draw dormant relationships first, so they cannot overwrite a live connection.
  edges.sort((a, b) => Number(a.active) - Number(b.active));
  if (geometry !== cache.geometry) {
    cache.geometry = geometry;
    cache.paths = [];
    for (const { parent, child, active, flow } of edges) {
      if (!child.node.parentID && parent.node.lane !== "live" && parent.node.lane === child.node.lane) {
        // One separator between whole parent families, never through the drawer.
        const upper = parent.y < child.y ? parent : child;
        const lower = upper === parent ? child : parent;
        const familyBottom = Math.max(upper.y + upper.height,
          ...scene.bubbles.filter(box => box.node.id === upper.node.id || (box.node.parentID && box.node.stepIndex === upper.node.stepIndex && upper.node.previewIteration === undefined)).map(box => box.y + box.height));
        if (familyBottom < lower.y) cache.paths.push({
          points: [{ x: upper.x + Math.floor(upper.width / 2), y: Math.floor((familyBottom + lower.y - 1) / 2) }],
          active: false, flow: false,
        });
        continue;
      }
      if (child.node.parentID && child.y > parent.y + parent.height) {
        const siblings = edges.filter(edge => edge.parent === parent && edge.child.node.parentID).map(edge => edge.child);
        const bundled = siblingPath(scene, parent, child, siblings);
        if (bundled) { cache.paths.push({ points: bundled, active, flow }); continue; }
      }
      let start: Point, end: Point, bends: Point[];
      const separated = parent.x + parent.width <= child.x || child.x + child.width <= parent.x;
      if (separated && (parent.node.lane !== "live" || child.node.lane !== "live" || parent.y === child.y)) {
        const rightward = child.x > parent.x;
        start = { x: rightward ? parent.x + parent.width : parent.x - 1, y: parent.y + 2 };
        end = { x: rightward ? child.x - 1 : child.x + child.width, y: child.y + 2 };
        const middle = Math.floor((start.x + end.x) / 2);
        bends = [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
      } else {
        const downward = child.y > parent.y;
        start = { x: parent.x + Math.floor(parent.width / 2), y: downward ? parent.y + parent.height : parent.y - 1 };
        end = { x: child.x + Math.floor(child.width / 2), y: downward ? child.y - 1 : child.y + child.height };
        const middle = Math.floor((start.y + end.y) / 2);
        bends = [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end];
      }
      cache.paths.push({ points: avoidBubbles(scene, expand(bends)), active, flow });
    }
  }
  return cache.paths;
}
