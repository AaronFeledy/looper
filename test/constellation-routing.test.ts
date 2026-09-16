import { expect, test } from "bun:test";
import { createBackgroundAgent, createLoopState } from "../src/lib/state.ts";
import { constellationAgents, layoutConstellation, type ConstellationScene } from "../src/presentation/tui/constellation.ts";
import { routeConstellationLinks, type Point, type WireCache } from "../src/presentation/tui/constellation-routing.ts";

function family(parents: number[]) {
  const state = createLoopState({maxIterations: 1, stepNames: ["Cleanup"]});
  state.steps[0]!.status = "running";
  state.steps[0]!.sessionID = "ses_root";
  state.steps[0]!.backgroundAgents = parents.map((parent, i) => createBackgroundAgent(`ses_child${i}`, 0,
    {agent: "Sisyphus-Junior", activity: "busy", parentSessionID: parent < 0 ? "ses_root" : `ses_child${parent}`}));
  return constellationAgents(state);
}
const key = (p: Point) => `${p.x}:${p.y}`;
function paths(scene: ConstellationScene) {
  return routeConstellationLinks(scene, {geometry: "", paths: []});
}
function assertClear(scene: ConstellationScene) {
  const routes = paths(scene);
  expect(routes.length).toBe(scene.bubbles.length - 1);
  for (const route of routes) {
    expect(route.points.length).toBeGreaterThan(0);
    expect(new Set(route.points.map(key)).size).toBe(route.points.length);
    for (const [i, point] of route.points.entries()) {
      expect(point.x >= 0 && point.x < scene.width && point.y >= 0 && point.y < scene.height).toBe(true);
      expect(scene.bubbles.some(box => point.x >= box.x && point.x < box.x + box.width &&
        point.y >= box.y && point.y < box.y + box.height)).toBe(false);
      if (i) {
        const previous = route.points[i - 1]!;
        expect(Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y)).toBe(1);
        expect(point.y).toBeGreaterThanOrEqual(previous.y);
      }
    }
  }
  return routes;
}

test("the reported five siblings share one trunk, with no connector loops", () => {
  for (const count of [1, 2, 5, 25]) for (const width of [16, 32, 80, 106, 139, 240]) {
    const scene = layoutConstellation(family(Array(count).fill(-1)), width);
    const routes = assertClear(scene);
    const vertices = new Set<string>(), edges = new Set<string>();
    for (const route of routes) route.points.forEach((point, i) => {
      vertices.add(key(point));
      if (i) edges.add([key(route.points[i - 1]!), key(point)].sort().join("/"));
    });
    // A single connected tree has no redundant parallel routes/cycles.
    expect(edges.size).toBe(vertices.size - 1);
    if (count === 5 && width === 139) {
      const root = scene.bubbles[0]!;
      const stemX = root.x + Math.floor(root.width / 2);
      const firstRow = scene.bubbles[1]!.y;
      const row = new Set(routes.flatMap(route => route.points.filter(p => p.y === firstRow + 1).map(p => p.x)));
      expect([...row]).toEqual([stemX]);
      const last = scene.bubbles.at(-1)!;
      expect(last.x + Math.floor(last.width / 2)).toBe(stemX);
    }
  }
});

test("nested families have separate corridors and never merge unrelated parent links", () => {
  for (const parents of [[-1, -1, -1, 0], [-1, -1, 0, 0, 1, 1, 2, 2], [-1, 0, 1, 2, 3]]) {
    for (const width of [32, 80, 106, 139, 240]) {
      const scene = layoutConstellation(family(parents), width);
      const routes = assertClear(scene);
      const owners = new Map<string, string>();
      for (const route of routes) {
        const end = route.points.at(-1)!;
        const child = scene.bubbles.find(box => box.y - 1 === end.y && box.x + Math.floor(box.width / 2) === end.x)!;
        expect(child).toBeDefined();
        for (const point of route.points) {
          const prior = owners.get(key(point));
          expect(prior === undefined || prior === child.node.parentID).toBe(true);
          owners.set(key(point), child.node.parentID!);
        }
      }
    }
  }
});

test("cached wires update when activity or compact state changes without moving cards", () => {
  const scene = layoutConstellation(family([-1]), 139);
  const cache: WireCache = {geometry: "", paths: []};
  expect(routeConstellationLinks(scene, cache)[0]!.active).toBe(true);
  scene.bubbles[1]!.node.status = "idle";
  expect(routeConstellationLinks(scene, cache)[0]!.active).toBe(false);
  scene.bubbles[1]!.compact = true;
  expect(routeConstellationLinks(scene, cache)).toHaveLength(0);
});
