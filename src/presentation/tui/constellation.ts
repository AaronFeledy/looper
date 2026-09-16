import { displayStepAt, displaySteps } from "../../lib/state.ts";
import { childActivitySummary, stepActivitySummary } from "./agent-activity.ts";
import { backgroundAgentLabel, type LoopState, type StepRestartReason, type StepStatus } from "../../lib/state.ts";

export type AgentBubble = {
  id: string; stepIndex: number; sessionID?: string; parentID?: string;
  name: string; summary: string; status: StepStatus | "idle"; lane: "live" | "past" | "next";
  previewIteration?: number;
  completedCount?: number; expanded?: boolean;
  restartReason?: StepRestartReason; parentName?: string; badge?: string; selected: boolean; startedAt?: number; finishedAt?: number;
};
export type ConstellationRegion = "center" | "pastHead" | "pastTail" | "nextHead" | "nextTail";
export type BubblePlacement = { node: AgentBubble; x: number; y: number; width: number; height: number; prominence?: number; region?: ConstellationRegion; compact?: boolean; traveling?: boolean };
export type IterationPreview = { iteration: number; stepNames: readonly string[] };
export type LoopMarker = { x: number; y: number; width: number; height: number; iteration: number; traveling?: boolean; region?: ConstellationRegion };
export type ConstellationScene = {
  loopMarker?: LoopMarker;
  bubbles: BubblePlacement[]; labels: { text: string; x: number; y: number }[];
  width: number; height: number;
  regions?: Record<"center" | "pastTail" | "nextTail", { x: number; y: number; width: number; height: number }>;
};

// Weak ownership keeps expansion local to this exact step attempt and iteration.
const expandedAgents = new WeakSet<object>();

export function toggleConstellationChildren(state: LoopState, node?: AgentBubble): boolean {
  const parent = node ?? constellationAgents(state).find(candidate => candidate.selected);
  if (!parent || !parent.completedCount) return false;
  const step = displayStepAt(state, parent.stepIndex);
  const owner = parent.parentID ? step?.backgroundAgents.find(agent => agent.sessionID === parent.sessionID) : step;
  if (!owner) return false;
  if (expandedAgents.has(owner)) expandedAgents.delete(owner);
  else expandedAgents.add(owner);
  selectConstellationAgent(state, parent);
  return true;
}

export function constellationAgents(state: LoopState, now = Date.now()): AgentBubble[] {
  const nodes: AgentBubble[] = [];
  for (const [stepIndex, step] of displaySteps(state)) {
    const id = `step:${stepIndex}`;
    const waiting = state.pendingRequests.find((request) => request.sessionID === step.sessionID);
    const live = step.status === "running" || step.status === "waiting";
    const selected = (state.selectedStepIndex ?? state.activeStepIndex) === stepIndex;
    const boot = !state.started && state.bootResumeSession?.stepIndex === stepIndex ? state.bootResumeSession : undefined;
    const badge = boot?.workState === "running" && !boot.canReattach ? "recovery" : waiting ? "needs you" : stepIndex === state.activeStepIndex && state.todos.length
      ? `${state.todos.filter((todo) => todo.status === "completed").length}/${state.todos.length} todos` : undefined;
    const lane = stepIndex < 0 ? "past" : live || step.status === "failed" ? "live" : step.status === "pending" ? "next" : "past";
    nodes.push({
      id, stepIndex, sessionID: step.sessionID, name: step.name, status: step.status,
      lane, restartReason: step.restartReason,
      summary: boot?.workState === "running" ? boot.canReattach ? "Resuming session" : "Session needs recovery"
        : stepActivitySummary(step, waiting, state.activityContext),
      selected: selected && state.selectedBackgroundSessionID === null,
      startedAt: step.startedAt, finishedAt: step.finishedAt, badge,
    });
    for (const agent of step.backgroundAgents) {
      const parent = step.backgroundAgents.find((candidate) => candidate.sessionID === agent.parentSessionID);
      const request = state.pendingRequests.find((candidate) => candidate.sessionID === agent.sessionID);
      const idle = agent.activity === "idle";
      nodes.push({
        id: `child:${stepIndex}:${agent.sessionID}`, stepIndex, sessionID: agent.sessionID,
        parentID: parent ? `child:${stepIndex}:${parent.sessionID}` : id,
        parentName: parent ? backgroundAgentLabel(parent) : step.name,
        name: backgroundAgentLabel(agent),
        status: request ? "waiting" : idle ? "idle" : "running",
        lane,
        summary: childActivitySummary(agent, request, now, state.activityContext),
        selected: selected && state.selectedBackgroundSessionID === agent.sessionID,
        startedAt: agent.startedAt, finishedAt: agent.finishedAt, badge: request ? "needs you" : undefined,
      });
    }
  }
  for (const root of nodes.filter(node => !node.parentID)) {
    const family = nodes.filter(node => node.stepIndex === root.stepIndex && node.parentID);
    const working = workingFamilyIDs(family);
    for (const node of [root, ...family]) {
      node.completedCount = family.filter(child => child.parentID === node.id && !working.has(child.id)).length;
      const step = displayStepAt(state, node.stepIndex)!;
      const owner = node.parentID ? step.backgroundAgents.find(agent => agent.sessionID === node.sessionID) : step;
      node.expanded = owner ? expandedAgents.has(owner) : false;
    }
  }
  return nodes;
}

/** Keep idle intermediaries visible until their last active descendant settles. */
function workingFamilyIDs(family: AgentBubble[]): Set<string> {
  const ids = new Set(family.filter(node => node.lane === "live" && node.status !== "idle").map(node => node.id));
  for (const node of family.filter(node => ids.has(node.id))) {
    let parentID = node.parentID;
    const seen = new Set<string>();
    while (parentID && !seen.has(parentID)) {
      seen.add(parentID); ids.add(parentID);
      parentID = family.find(candidate => candidate.id === parentID)?.parentID;
    }
  }
  return ids;
}

/** Reveal only direct children of opened drawers, plus live ancestry. */
export function visibleConstellationAgents(nodes: AgentBubble[]): AgentBubble[] {
  const visible: AgentBubble[] = [];
  const visit = (parent: AgentBubble, working: Set<string>) => {
    if (visible.some(node => node.id === parent.id)) return;
    visible.push(parent);
    for (const child of nodes.filter(node => node.parentID === parent.id)) {
      if (parent.expanded || working.has(child.id)) visit(child, working);
    }
  };
  for (const root of nodes.filter(node => !node.parentID))
    visit(root, workingFamilyIDs(nodes.filter(node => node.stepIndex === root.stepIndex && node.parentID)));
  return visible;
}

/** One pass ahead; previews never reuse sessions or transient retry rows. */
export function constellationNextIteration(state: LoopState): IterationPreview | undefined {
  const iteration = Math.max(1, state.iteration) + 1;
  if (iteration > state.maxIterations || state.stopAfterIteration || state.quitting || !state.configuredStepNames.length) return undefined;
  return { iteration, stepNames: state.configuredStepNames };
}

/** Families own their children until the top-level agent retires. */
export function layoutConstellation(nodes: AgentBubble[], width: number, preview?: IterationPreview): ConstellationScene {
  width = Math.max(16, Math.floor(width));
  const wide = width >= 106, edge = wide ? 23 : 0;
  const centerWidth = width - edge * 2;
  const roots = nodes.filter(node => !node.parentID);
  const live = roots.filter(node => node.lane === "live");
  const past = roots.filter(node => node.lane === "past").sort((a, b) => a.stepIndex < 0 && b.stepIndex < 0 ? a.stepIndex - b.stepIndex : b.stepIndex - a.stepIndex);
  const next = roots.filter(node => node.lane === "next");
  const bubbles: BubblePlacement[] = [];
  const labels: ConstellationScene["labels"] = [];
  let loopMarker: LoopMarker | undefined;
  const regions: ConstellationScene["regions"] = wide ? {
    center: { x: edge, y: 1, width: centerWidth, height: 1 },
    pastTail: { x: 0, y: 8, width: 21, height: 1 },
    nextTail: { x: width - 21, y: 8, width: 21, height: 1 },
  } : undefined;
  const place = (node: AgentBubble, x: number, y: number, w: number, h: number, region?: ConstellationRegion, compact = false) => {
    bubbles.push({ node, x, y, width: w, height: h, region, compact,
      prominence: node.lane !== "live" || node.status === "idle" ? 0 : compact ? 0.12 : node.parentID ? 0.65 : 1 });
  };
  const visibleNodes = visibleConstellationAgents(nodes);
  const childrenOf = (root: AgentBubble) => visibleNodes.filter(node => node.stepIndex === root.stepIndex && node.parentID);
  labels.push({ text: live.length ? `WORKING NOW · ${nodes.filter(node => node.lane === "live" && node.status !== "idle").length} agents` : "THE STAGE IS QUIET", x: edge, y: 0 });
  let bottom = 2;
  for (const root of live) {
    const family = childrenOf(root);
    const active = family;
    // Grow the working family with the terminal, while preserving side lanes
    // and keeping children visually smaller than the configured step.
    const w = Math.min(centerWidth, Math.max(34, Math.min(72, Math.floor(width * 0.36))));
    const activeChildWidth = Math.min(w - 4, 56, Math.max(28, Math.floor(width * 0.27)));
    const x = edge + Math.floor((centerWidth - w) / 2);
    const y = bottom;
    place(root, x, y, w, 5, wide ? "center" : undefined);
    let childY = y + 8;
    // Lay out whole subtrees together. A sibling with descendants owns its
    // vertical block, so another family's links never run through that block.
    const placed = new Set<string>();
    const layoutChildren = (parentID: string, left: number, available: number, top: number): number => {
      const children = active.filter(node => node.parentID === parentID && !placed.has(node.id));
      if (!children.length) return top;
      children.forEach(node => placed.add(node.id));
      const leavesOnly = children.every(node => !active.some(child => child.parentID === node.id));
      // Crowded families can trade some line length for an extra column.
      // Keep 24 columns per child plus the connector gutter; single children
      // and pairs retain the roomier sizing whenever possible.
      const crowded = children.length > 2 && available < 96;
      const cols = available >= (crowded ? 52 : 64) && children.length > 1 ? 2 : 1;
      // Multi-row single-column families need their own gutter, outside all
      // descendants. Two-column leaf families share the clear central gutter.
      const gutter = children.length > 1 && cols === 1 ? Math.min(3, Math.max(0, available - 10)) : 0;
      const innerLeft = left + gutter, innerWidth = available - gutter;
      const childWidth = Math.min(crowded ? Math.min(32, activeChildWidth) : activeChildWidth, Math.floor((innerWidth - 4 * (cols - 1)) / cols));
      if (!leavesOnly && cols === 2) {
        // Each column owns whole subtrees; fill the shorter column next.
        // The center gutter remains clear for the common parent's trunk.
        const laneWidth = Math.floor((innerWidth - 4) / 2);
        const columnTop = [top, top];
        for (const node of children) {
          const col = columnTop[0]! <= columnTop[1]! ? 0 : 1;
          const laneLeft = innerLeft + col * (laneWidth + 4);
          const cursor = columnTop[col]!;
          place(node, laneLeft + Math.floor((laneWidth - childWidth) / 2), cursor,
            childWidth, node.completedCount ? 5 : 4, wide ? "center" : undefined);
          columnTop[col] = layoutChildren(node.id, laneLeft, laneWidth, cursor + 6);
        }
        return Math.max(...columnTop);
      }
      let cursor = top;
      for (let i = 0; i < children.length; i += cols) {
        const count = Math.min(cols, children.length - i);
        const startX = innerLeft + Math.floor((innerWidth - (count * childWidth + (count - 1) * 4)) / 2);
        for (let col = 0; col < count; col++) {
          const node = children[i + col]!;
          place(node, startX + col * (childWidth + 4), cursor, childWidth, node.completedCount ? 5 : 4, wide ? "center" : undefined);
        }
        cursor += 6;
        if (!leavesOnly) cursor = layoutChildren(children[i]!.id, innerLeft, innerWidth, cursor);
      }
      return cursor;
    };
    childY = layoutChildren(root.id, edge, centerWidth, childY);
    bottom = Math.max(y + 7, active.length ? childY : 0);
  }
  const centerBottom = bottom;
  for (const [lane, group] of [["past", past], ["next", next]] as const) {
    if (!wide && !group.length && !(lane === "next" && preview)) continue;
    const x = wide ? lane === "past" ? 0 : width - 21 : 0;
    const w = wide ? 21 : Math.min(34, width);
    let y = wide ? 2 : bottom + 3;
    labels.push({ text: `${lane === "past" ? "TRAIL" : "UP NEXT"} · ${group.length + (lane === "next" ? preview?.stepNames.length ?? 0 : 0)}`, x, y: wide ? 0 : y - 2 });
    for (const [index, root] of group.entries()) {
      const region = wide ? lane === "past" ? index === 0 ? "pastHead" : "pastTail" : index === 0 ? "nextHead" : "nextTail" : undefined;
      place(root, x, y, w, 5, region);
      const family = childrenOf(root);
      // Preorder keeps nested descendants next to their owner in the drawer.
      const ordered: { node: AgentBubble; depth: number }[] = [];
      const visit = (parentID: string, depth: number) => {
        for (const node of family.filter(node => node.parentID === parentID && !ordered.some(item => item.node.id === node.id))) {
          ordered.push({ node, depth }); visit(node.id, depth + 1);
        }
      };
      visit(root.id, 1);
      ordered.forEach(({ node, depth }, i) => {
        const indent = Math.min(6, depth * 2);
        place(node, x + indent, y + 6 + i, w - indent, 1,
          wide ? lane === "past" ? "pastTail" : "nextTail" : undefined, true);
      });
      y += family.length ? 7 + family.length : 6;
    }
    if (lane === "next" && preview) {
      loopMarker = { x, y, width: w, height: 3, iteration: preview.iteration,
        region: wide ? group.length ? "nextTail" : "nextHead" : undefined };
      y += wide && !group.length ? 6 : 4;
      preview.stepNames.forEach((name, index) => {
        place({
          id: `preview:${preview.iteration}:${index}`, stepIndex: index,
          name, summary: "Awaiting turn", status: "pending", lane: "next",
          selected: false, previewIteration: preview.iteration,
        }, x, y, w, 5, wide ? "nextTail" : undefined);
        y += 6;
      });
    }
    if (regions) regions[lane === "past" ? "pastTail" : "nextTail"].height = Math.max(1, y - 8);
    bottom = Math.max(bottom, y);
  }
  if (regions) regions.center.height = Math.max(1, centerBottom - 1);
  return { bubbles, labels, width, height: bottom + 1, regions, ...(loopMarker ? { loopMarker } : {}) };
}

export function selectConstellationAgent(state: LoopState, node: AgentBubble): void {
  if (node.previewIteration !== undefined) return;
  state.selectedStepIndex = node.stepIndex;
  state.selectedBackgroundSessionID = node.parentID ? node.sessionID ?? null : null;
  state.manualStepSelection = true;
  state.focusedPane = "steps";
}

export function moveConstellationSelection(state: LoopState, delta: number): void {
  const nodes = visibleConstellationAgents(constellationAgents(state)).sort((a, b) =>
    ({ live: 0, next: 1, past: 2 }[a.lane]) - ({ live: 0, next: 1, past: 2 }[b.lane]));
  if (!nodes.length) return;
  const at = nodes.findIndex((node) => node.selected);
  const node = nodes[(Math.max(0, at) + delta + nodes.length) % nodes.length]!;
  selectConstellationAgent(state, node);
}
