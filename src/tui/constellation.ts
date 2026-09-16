import { ciIsRunning } from "./ci-progress.ts";
import { constellationDockPanels } from "../presentation/tui/constellation-dock.ts";
import { createDockFeedback } from "./dock-feedback.ts";
import { ArrowScrollBoxRenderable } from "./arrow-scroll-box.ts";
import { BoxRenderable, LayoutEvents, RenderableEvents, ScrollBoxRenderable, TextAttributes, TextRenderable, type CliRenderer } from "@opentui/core";
import { ansiToStyledText } from "../lib/ansi.ts";
import { notify, subscribe, type LoopState } from "../lib/state.ts";
import { constellationAgents, constellationNextIteration, layoutConstellation, selectConstellationAgent, toggleConstellationChildren, visibleConstellationAgents, type AgentBubble, type BubblePlacement, type ConstellationScene } from "../presentation/tui/constellation.ts";
import { createConstellationTransition } from "../presentation/tui/constellation-transition.ts";
import { openAgentInspector } from "../lib/agent-inspector-state.ts";
import { AgentBubbleRenderable, activityRing } from "./agent-bubble.ts";
import { createAgentInspector } from "./agent-inspector.ts";
import { modalFocusWinner } from "./permission-gate.ts";
import { createAgentStream } from "./agent-stream.ts";
import { createStepList, durationSecondsFrom } from "./step-list.ts";
import { displayWidth, truncateDisplay } from "./text-layout.ts";
import { flowingActivityText } from "./activity-text.ts";
import { buildTodoPanelLines } from "./todo-panel.ts";

import { routeConstellationLinks, type Point, type WireCache } from "../presentation/tui/constellation-routing.ts";
export type { WireCache } from "../presentation/tui/constellation-routing.ts";

const BG = "#101821";
const MUTED = "#667789";
type RGB = readonly [number, number, number];
function mixColor(from: RGB, to: RGB, amount: number): [number, number, number] {
  return from.map((value, i) => Math.round(value + (to[i]! - value) * amount)) as [number, number, number];
}
const hexColor = (color: RGB) => "#" + color.map((value) => value.toString(16).padStart(2, "0")).join("");
const colorEscape = (color: RGB) => `\x1b[38;2;${color.join(";")}m`;
const pulse = (phase: number) => (1 - Math.cos(phase)) / 2;
const isMoving = (node: AgentBubble) => node.status === "running";

export function constellationLinks(scene: ConstellationScene, frame: number, motion: boolean, cache: WireCache): string {
  const cells = new Map<string, { mask: number; active: boolean; glow: number }>();
  routeConstellationLinks(scene, cache);
  for (const { points, active } of cache.paths) {
    const direction = (from: Point, to: Point) => to.y < from.y ? 1 : to.x > from.x ? 2 : to.y > from.y ? 4 : 8;
    points.forEach((point, i) => {
      const key = `${point.x}:${point.y}`;
      let mask = 0;
      if (i > 0) mask |= direction(point, points[i - 1]!);
      if (i + 1 < points.length) mask |= direction(point, points[i + 1]!);
      const prior = cells.get(key);
      const glow = active ? motion ? pulse(i / 7 - frame / 10) : 0.45 : 0;
      cells.set(key, { mask: mask | (prior?.mask ?? 0), active: active || prior?.active === true, glow: Math.max(glow, prior?.glow ?? 0) });
    });
  }
  const glyphs: Record<number, string> = { 1: "│", 2: "─", 4: "│", 8: "─", 5: "│", 10: "─", 3: "╰", 6: "╭", 9: "╯", 12: "╮", 7: "├", 11: "┴", 13: "┤", 14: "┬", 15: "┼" };
  return Array.from({ length: scene.height }, (_, y) => Array.from({ length: scene.width }, (_, x) => {
    const key = `${x}:${y}`, cell = cells.get(key);
    if (!cell) return " ";
    return cell.active
      ? colorEscape(mixColor([51, 70, 87], [143, 215, 211], cell.glow)) + (glyphs[cell.mask] ?? "·") + "\x1b[38;2;51;70;87m"
      : cell.mask === 5 ? "┊" : "·";
  }).join("")).join("\n");
}

export function createConstellationView(renderer: CliRenderer, state: LoopState): BoxRenderable {
  // Eight scroll panes here plus four shared help/prompt/config/diagnostics overlays
  // each own a native renderer selection listener. Keep a finite, renderer-local
  // allowance for that fixed UI tree; do not disable leak warnings globally.
  const listenerLimit = renderer.getMaxListeners();
  if (listenerLimit > 0 && listenerLimit < 16) renderer.setMaxListeners(16);
  const host = new BoxRenderable(renderer, { id: "constellation", width: "100%", height: "100%", flexDirection: "row", backgroundColor: BG });
  const stage = new BoxRenderable(renderer, { id: "constellation-stage", flexGrow: 0, flexShrink: 0, minWidth: 0, height: "100%", flexDirection: "column" });
  const heading = new TextRenderable(renderer, { id: "constellation-heading", height: 1, width: "100%", fg: "#c9eee9", attributes: TextAttributes.BOLD, truncate: true, content: "C O N S T E L L A T I O N" });
  const legend = new TextRenderable(renderer, { id: "constellation-legend", height: 1, width: "100%", fg: MUTED, truncate: true, content: "" });
  const field = new ScrollBoxRenderable(renderer, {
    id: "constellation-field", width: "100%", flexGrow: 1, minHeight: 1, scrollX: false, scrollY: true,
    contentOptions: { minHeight: "auto", width: "100%" },
  });
  const canvas = new BoxRenderable(renderer, { id: "constellation-canvas", width: "100%", height: 24, overflow: "hidden" });
  const wires = new TextRenderable(renderer, { id: "constellation-wires", position: "absolute", left: 0, top: 0, width: "100%", height: 24, fg: "#334657", wrapMode: "none", selectable: false, content: "" });
  canvas.add(wires);
  const loopMarker = new TextRenderable(renderer, {
    id: "constellation-loop-marker", position: "absolute", height: 3, zIndex: 3,
    fg: "#91d9df", bg: BG, selectable: false, wrapMode: "none", content: "", visible: false,
  });
  canvas.add(loopMarker);
  field.add(canvas);
  const regions = Object.fromEntries((["center", "pastTail", "nextTail"] as const).map(id => {
    const ScrollRegion = id === "center" ? ScrollBoxRenderable : ArrowScrollBoxRenderable;
    const scroll = new ScrollRegion(renderer, { ...(id !== "center" ? { motionState: state } : {}),
      id: `constellation-scroll-${id}`, position: "absolute", scrollX: false, scrollY: true,
      viewportCulling: false,
      contentOptions: { minHeight: "auto" }, zIndex: 1,
      onMouseScroll: () => notify(),
    });
    const content = new BoxRenderable(renderer, { id: `constellation-content-${id}`, height: 1, width: 1 });
    const links = new TextRenderable(renderer, { id: `constellation-links-${id}`, position: "absolute", left: 0, top: 0, selectable: false, wrapMode: "none", content: "", fg: "#334657" });
    content.add(links); scroll.add(content); canvas.add(scroll);
    return [id, { scroll, content, links, cache: { geometry: "", paths: [] } as WireCache }];
  })) as Record<"center" | "pastTail" | "nextTail", { scroll: ScrollBoxRenderable; content: BoxRenderable; links: TextRenderable; cache: WireCache }>;
  let lastScrollKey = "";
  let lastScope = state.steps;
  const regionFor = (item: Pick<BubblePlacement, "region">) => item.region && item.region in regions ? regions[item.region as keyof typeof regions] : undefined;
  const dock = new BoxRenderable(renderer, { id: "constellation-dock", width: "100%", height: 3, flexDirection: "row", gap: 1 });
  const plan = new ScrollBoxRenderable(renderer, { id: "constellation-plan", width: "100%", height: 7, flexShrink: 0, border: true, borderStyle: "rounded", borderColor: "#667692", title: "Work plan · i close · ↑↓ scroll", scrollX: false, scrollY: true, visible: false, contentOptions: { minHeight: "auto" } });
  const planText = new TextRenderable(renderer, { id: "constellation-plan-text", width: "100%", wrapMode: "none", content: "", fg: "#c7d4df" });
  plan.add(planText);
  stage.add(heading); stage.add(legend); stage.add(field); stage.add(plan); stage.add(dock);
  const history = createStepList(renderer, state);
  history.visible = false;
  const stream = createAgentStream(renderer, state);
  stream.visible = false;
  host.add(history); host.add(stage);
  host.add(createAgentInspector(renderer, state, stream, host));
  type Card = { box: AgentBubbleRenderable; name: TextRenderable; summary: TextRenderable; meta: TextRenderable; countOffset?: number; node: AgentBubble };
  const cards = new Map<string, Card>();
  const labels: TextRenderable[] = [];
  const capsules: { box: BoxRenderable; text: TextRenderable }[] = [];
  const dockFeedback = createDockFeedback();
  let dockAnimating = false;
  let frame = 0;
  const animationEpoch = Date.now();
  const layoutMotion = createConstellationTransition();
  let lastSelected = "";
  let lastClick: { id: string; at: number } | undefined;
  const wireCache: WireCache = { geometry: "", paths: [] };
  let painting = false;
  let lastTimedPaint = 0;

  const paint = (): void => {
    if (painting || host.isDestroyed) return;
    painting = true;
    try {
      const inHistory = state.historyView !== null;
      history.visible = inHistory;
      stage.visible = !inHistory;
      const stageWidth = host.width || renderer.width;
      stage.width = stageWidth;
      if (inHistory) { renderer.requestRender(); return; }
      plan.visible = state.constellation?.planOpen === true;
      plan.height = Math.max(3, Math.min(8, state.todos.length + 2, Math.floor(renderer.height / 3)));
      plan.title = `Work plan · ${state.steps[state.activeStepIndex ?? -1]?.name ?? "latest agent"} · i close · ↑↓ scroll`;
      planText.content = buildTodoPanelLines(state.todos, stageWidth - 4).map((line) => line.content).join("\n") || "No work plan reported yet.";
      plan.scrollTop = state.constellation?.planScroll ?? 0;
      let nodes = constellationAgents(state);
      const visible = visibleConstellationAgents(nodes);
      let selectedNode = nodes.find(node => node.selected);
      if (selectedNode && !visible.includes(selectedNode) && modalFocusWinner(state) === "none") {
        const seen = new Set<string>();
        while (selectedNode?.parentID && !visible.includes(selectedNode) && !seen.has(selectedNode.id)) {
          seen.add(selectedNode.id);
          selectedNode = nodes.find(node => node.id === selectedNode!.parentID);
        }
        if (selectedNode) { selectConstellationAgent(state, selectedNode); nodes = constellationAgents(state); }
      }
      const width = Math.max(16, stageWidth - 2);
      const motion = !state.constellation?.reducedMotion;
      const target = layoutConstellation(nodes, width, constellationNextIteration(state));
      const viewportHeight = Math.max(1, field.viewport.height || renderer.height - 5);
      if (lastScope !== state.steps) {
        Object.values(regions).forEach(region => { region.scroll.scrollTop = 0; });
        field.scrollTop = 0;
        lastScope = state.steps;
      }
      for (const [id, region] of Object.entries(regions)) {
        const bounds = target.regions?.[id as keyof typeof regions];
        region.scroll.visible = Boolean(bounds);
        if (!bounds) continue;
        const sideColumn = id !== "center";
        // The top hint uses the gap below the pinned head; content keeps its
        // existing coordinates, with the bottom row reserved for the lower hint.
        region.scroll.left = bounds.x; region.scroll.top = bounds.y - (sideColumn ? 1 : 0);
        region.scroll.width = bounds.width + (sideColumn ? 0 : 1);
        const scrollHeight = Math.max(1, viewportHeight - bounds.y + (sideColumn ? 1 : 0));
        region.scroll.height = scrollHeight;
        region.content.width = bounds.width;
        region.content.height = Math.max(bounds.height, scrollHeight - (sideColumn ? 2 : 0));
        region.links.width = bounds.width; region.links.height = bounds.height;
      }
      const scrollKey = JSON.stringify(Object.values(regions).map(region => region.scroll.scrollTop));
      const scrolled = scrollKey !== lastScrollKey;
      lastScrollKey = scrollKey;
      const projected = target.regions ? { ...target,
        ...(target.loopMarker ? { loopMarker: {
          ...target.loopMarker, y: target.loopMarker.y - (regionFor(target.loopMarker)?.scroll.scrollTop ?? 0),
        } } : {}),
        bubbles: target.bubbles.map(item => ({
        ...item, y: item.y - (regionFor(item)?.scroll.scrollTop ?? 0),
      })) } : target;
      const scene = layoutMotion.sample(projected, Date.now(), {
        animate: motion && !scrolled && modalFocusWinner(state) === "none", scope: state.steps,
      });
      canvas.height = target.regions ? viewportHeight : scene.height;
      if (target.regions) field.scrollTop = 0;
      wires.height = target.regions ? viewportHeight : scene.height;
      wires.width = scene.width;
      const moving = layoutMotion.isTransitioning();
      const globalScene = target.regions ? {
        ...scene, height: viewportHeight,
        bubbles: scene.bubbles.filter(item => (moving || !item.node.parentID) && item.y >= 1 && item.y + item.height <= viewportHeight),
      } : scene;
      wires.content = ansiToStyledText(constellationLinks(globalScene, frame, motion, wireCache));
      for (const [id, region] of Object.entries(regions)) {
        const bounds = target.regions?.[id as keyof typeof regions];
        if (!bounds) continue;
        region.links.visible = !moving;
        region.links.content = ansiToStyledText(constellationLinks({
          ...target, width: bounds.width, height: bounds.height,
          bubbles: target.bubbles.filter(item => item.region === id ||
            id === "pastTail" && item.region === "pastHead" ||
            id === "nextTail" && item.region === "nextHead").map(item => ({ ...item, x: item.x - bounds.x, y: item.y - bounds.y })),
        }, frame, motion, region.cache));
      }
      loopMarker.visible = Boolean(scene.loopMarker);
      if (scene.loopMarker) {
        const item = scene.loopMarker;
        const region = target.regions && !item.traveling ? regionFor(item) : undefined;
        const bounds = region && item.region ? target.regions![item.region as keyof typeof regions] : undefined;
        const owner = region?.content ?? canvas;
        if (loopMarker.parent !== owner) { loopMarker.parent?.remove(loopMarker); owner.add(loopMarker); }
        loopMarker.left = item.x - (bounds?.x ?? 0);
        loopMarker.top = item.y - (bounds?.y ?? 0) + (region?.scroll.scrollTop ?? 0);
        loopMarker.width = item.width;
        const center = (text: string) => " ".repeat(Math.max(0, Math.floor((item.width - displayWidth(text)) / 2))) + text;
        loopMarker.content = center("──── ↻ ────") + "\n" + center(`ITERATION ${item.iteration}`);
      }
      legend.content = `↑↓ agents  ·  tab subagents  ·  o inspect  ·  i plan  ·  m ${motion ? "still" : "animate"}  ·  wheel scroll column  ·  g run  ·  p pause`;
      const ids = new Set(scene.bubbles.map((item) => item.node.id));
      for (const [id, card] of cards) if (!ids.has(id)) { card.box.parent?.remove(card.box); card.box.destroyRecursively(); cards.delete(id); }
      for (const item of scene.bubbles) {
        const { node } = item;
        let card = cards.get(node.id);
        if (!card) {
          const box = new AgentBubbleRenderable(renderer, {
            id: `bubble-${node.id}`, position: "absolute", border: true, borderStyle: "rounded", paddingX: 1,
            backgroundColor: BG, flexDirection: "column", zIndex: 2,
            onMouseUp(event) {
              if (event.button !== 0 || event.type !== "up") return;
              const current = cards.get(node.id);
              if (!current || current.node.previewIteration !== undefined || modalFocusWinner(state) !== "none") return;
              selectConstellationAgent(state, current.node);
              if (current.node.completedCount && (current.box.height === 1 && event.x >= current.name.x + (current.countOffset ?? Infinity) || (current.box.height > 1 && event.y === current.meta.y &&
                  event.x >= current.meta.x && event.x < current.meta.x + current.meta.width))) {
                toggleConstellationChildren(state, current.node);
                lastClick = undefined; notify(); return;
              }
              const now = Date.now();
              if (lastClick?.id === node.id && now - lastClick.at <= 400) {
                lastClick = undefined;
                openAgentInspector(state);
              } else {
                lastClick = { id: node.id, at: now };
                notify();
              }
            },
          });
          const name = new TextRenderable(renderer, { id: `name-${node.id}`, height: 1, width: "100%", selectable: false, truncate: true, content: "" });
          const summary = new TextRenderable(renderer, { id: `summary-${node.id}`, height: 1, width: "100%", selectable: false, truncate: true, content: "" });
          const meta = new TextRenderable(renderer, { id: `meta-${node.id}`, height: 1, width: "100%", selectable: false, truncate: true, content: "" });
          box.add(name); box.add(summary); box.add(meta); canvas.add(box);
          card = { box, name, summary, meta, node }; cards.set(node.id, card);
        }
        card.node = node;
        const region = target.regions && !item.traveling ? regionFor(item) : undefined;
        const bounds = region && item.region ? target.regions![item.region as keyof typeof regions] : undefined;
        const owner = region?.content ?? canvas;
        if (card.box.parent !== owner) { card.box.parent?.remove(card.box); owner.add(card.box); }
        card.box.left = item.x - (bounds?.x ?? 0);
        card.box.top = item.y - (bounds?.y ?? 0) + (region?.scroll.scrollTop ?? 0);
        card.box.width = item.width; card.box.height = item.height;
        const compact = item.compact === true;
        card.name.height = 1;
        card.summary.visible = !compact;
        card.meta.visible = !compact && (!node.parentID || Boolean(node.completedCount));

        const live = node.lane === "live";
        const prominence = item.prominence ?? (live ? 1 : 0);
        card.box.zIndex = item.traveling ? 6 : node.selected ? 5 : node.parentID ? 2 : 4;
        const timedOut = node.restartReason === "timeout";
        const attention = node.badge === "needs you" || node.status === "failed" || timedOut;
        // Ring pulses and border wakes share a family phase, with a satellite delay.
        const phase = frame / 8 + node.stepIndex * 1.7 - (node.parentID?.startsWith("child:") ? 0.8 : node.parentID ? 0.4 : 0);
        const animated = motion && isMoving(node) && !attention && !compact;
        const ring = activityRing(phase, animated);
        const bright: RGB = timedOut ? [243, 139, 168] : attention ? [243, 191, 122] : node.selected ? [215, 195, 255] : [173, 233, 224];
        const dim: RGB = timedOut ? [243, 139, 168] : attention ? [243, 191, 122] : node.selected ? [111, 96, 145] : mixColor([102, 119, 137], [63, 98, 111], prominence);
        const color = hexColor(mixColor(dim, bright, live && node.status !== "idle" ? 0.5 : node.selected ? 0.35 : 0));
        const glyph = timedOut ? "✗" : node.restartReason === "manual" ? "↻" : attention ? "!" : isMoving(node) ? ring.glyph : node.status === "waiting" ? "◷" : node.lane === "next" ? "○" : node.status === "skipped" ? "↷" : node.status === "idle" ? "·" : node.status === "done" ? "✓" : "○";
        card.box.borderColor = color;
        // Setting the native border color may initialize its border again.
        card.box.border = !compact;
        card.box.setChase(animated ? { phase, dim, bright } : undefined);
        card.box.backgroundColor = node.selected ? "#232137"
          : hexColor(mixColor([16, 24, 33], [23, 35, 46], prominence));
        const elapsed = durationSecondsFrom(node.startedAt, node.finishedAt, { live: isMoving(node) || node.status === "waiting" });
        const completedElapsed = node.finishedAt !== undefined &&
          (node.status === "done" || node.status === "failed" || node.status === "skipped" || node.status === "idle") ? elapsed : "";
        card.box.title = undefined;
        card.box.bottomTitle = !compact && node.badge ? ` ${node.badge} ` : undefined;
        card.box.bottomTitleAlignment = "right";
        const nameColor = mixColor([140, 155, 170], [225, 238, 239], prominence);
        const glyphColor: RGB = node.status === "skipped" ? [249, 226, 175] : attention ? bright : isMoving(node) ? mixColor([102, 110, 121], bright, ring.glow) : nameColor;
        const countSuffix = compact && node.completedCount ? ` ${node.expanded ? "▾" : "▸"}${node.completedCount}` : "";
        const titleWidth = item.width - (compact ? 2 : 4);
        const durationSuffix = !compact && completedElapsed ? ` ${completedElapsed}` : "";
        const titleBudget = Math.max(0, titleWidth - displayWidth(countSuffix) - displayWidth(durationSuffix));
        const title = truncateDisplay(`${compact ? "↳" : glyph} ${node.name}`, titleBudget, durationSuffix ? "..." : "…") + countSuffix;
        const name = title + (durationSuffix
          ? " ".repeat(Math.max(0, titleWidth - displayWidth(title) - displayWidth(durationSuffix))) + durationSuffix : "");
        card.countOffset = countSuffix ? displayWidth(name) - displayWidth(countSuffix) + 1 : undefined;
        card.name.content = ansiToStyledText(`${colorEscape(glyphColor)}${isMoving(node) && ring.bold ? "\x1b[1m" : "\x1b[22m"}${name.slice(0, 1)}\x1b[22m${colorEscape(nameColor)}${live && !node.parentID ? "\x1b[1m" : ""}${name.slice(1)}\x1b[0m`);
        card.name.fg = hexColor(nameColor);
        card.name.attributes = TextAttributes.NONE;
        const summary = truncateDisplay(node.summary, item.width - 4);
        card.summary.content = isMoving(node) && motion && !attention ? ansiToStyledText(flowingActivityText(summary, phase)) : summary;
        card.summary.fg = attention ? hexColor(bright) : hexColor(mixColor([102, 119, 137], [145, 217, 223], prominence));
        const relationship = node.previewIteration !== undefined ? `iteration ${node.previewIteration}` : node.completedCount ? `${node.expanded ? "▾" : "▸"} ${node.completedCount} sub agent${node.completedCount === 1 ? "" : "s"}` : node.parentName ? `from ${node.parentName}` : "agent";
        const metaText = `${relationship}${elapsed && !completedElapsed ? ` · ${elapsed}` : ""}`;
        card.meta.content = truncateDisplay(node.completedCount && displayWidth(metaText) > item.width - 4 ? relationship : metaText, item.width - 4);
        card.meta.fg = MUTED;
      }
      while (labels.length > scene.labels.length) { const label = labels.pop()!; canvas.remove(label); label.destroy(); }
      scene.labels.forEach((item, i) => {
        let label = labels[i];
        if (!label) { label = new TextRenderable(renderer, { id: `constellation-zone-${i}`, position: "absolute", height: 1, fg: MUTED, content: "", selectable: false, truncate: true }); labels.push(label); canvas.add(label); }
        label.left = item.x; label.top = item.y; label.width = Math.max(1, width - item.x);
        label.content = item.text;
      });
      constellationDockPanels(state).forEach((panel, i) => {
        let capsule = capsules[i];
        if (!capsule) {
          const box = new BoxRenderable(renderer, { id: `constellation-context-${i}`, border: true, borderStyle: "rounded", borderColor: "#354657", height: 3, flexGrow: 1, flexBasis: 0, minWidth: 0, paddingX: 1,
            onMouseUp(event) {
              if (event.button !== 0 || event.type !== "up" || modalFocusWinner(state) !== "none") return;
              if (i < 3) openAgentInspector(state, "context");
              if (i === 3 && state.constellation) { state.constellation.planOpen = !state.constellation.planOpen; state.focusedPane = "steps"; notify(); }
            } });
          const text = new TextRenderable(renderer, { id: `constellation-context-text-${i}`, width: "100%", height: 1, fg: "#95aaba", truncate: true, content: "" });
          box.add(text); dock.add(box); capsule = { box, text }; capsules.push(capsule);
        }
        const feedback = dockFeedback.sample(panel, Date.now(), motion);
        capsule.text.content = panel.content;
        capsule.box.borderColor = feedback.border;
        capsule.text.fg = feedback.text;
      });
      dockAnimating = dockFeedback.isPulsing(Date.now());
      const selected = target.bubbles.find((item) => item.node.selected);
      if (selected && lastSelected !== selected.node.id) {
        const region = target.regions ? regionFor(selected) : undefined;
        const scroller = region?.scroll ?? (target.regions ? undefined : field);
        const offset = region && selected.region ? target.regions![selected.region as keyof typeof regions].y : 0;
        if (scroller && scroller.viewport.height > 0) {
          const y = selected.y - offset;
          if (y < scroller.scrollTop) scroller.scrollTop = y;
          else if (y + selected.height > scroller.scrollTop + scroller.viewport.height)
            scroller.scrollTop = Math.max(0, y + selected.height - scroller.viewport.height);
        }
        lastSelected = selected.node.id;
      }
      renderer.requestRender();
    } finally { painting = false; }
  };
  const unsubscribe = subscribe(paint);
  host.on(LayoutEvents.RESIZED, paint);
  const timer = setInterval(() => {
    if (state.historyView !== null) return;
    const animate = !state.constellation?.reducedMotion && modalFocusWinner(state) === "none" && (constellationAgents(state).some(isMoving) || ciIsRunning(state.github) || dockAnimating);
    const now = Date.now();
    const moving = layoutMotion.isTransitioning();
    if (now - lastTimedPaint < (moving ? 40 : animate ? 80 : 1_000)) return;
    if (animate) frame = Math.floor((now - animationEpoch) / 80);
    lastTimedPaint = now;
    paint();
  }, 40);
  timer.unref?.();
  host.on(RenderableEvents.DESTROYED, () => { clearInterval(timer); unsubscribe(); host.off(LayoutEvents.RESIZED, paint); });
  paint();
  return host;
}
