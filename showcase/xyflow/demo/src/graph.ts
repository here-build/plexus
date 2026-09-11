import { FlowNode, type Flow } from "@here.build/plexus-xyflow-models";

export function newNodeId(): string {
  return `n-${crypto.randomUUID().slice(0, 8)}`;
}

export function topmost(nodes: readonly FlowNode[]): FlowNode[] {
  return nodes.filter((node) => !nodes.some((other) => other !== node && other.owns(node)));
}

export function addUntitled(
  flow: Flow,
  position: { x: number; y: number },
  label = "untitled",
  parent?: FlowNode | null,
): FlowNode {
  const origin = parent ? parent.absOrigin() : { x: 0, y: 0 };
  return flow.addNode({
    id: newNodeId(),
    x: position.x - origin.x,
    y: position.y - origin.y,
    label,
    width: 152,
    height: 56,
    parentId: parent?.id,
  });
}

export function addGroup(flow: Flow, origin: { x: number; y: number }, wrap: readonly FlowNode[] = []): FlowNode {
  const members = topmost(wrap);
  const shared = members[0]?.parent;
  const siblings = members.filter((node) => node.parent === shared);
  if (siblings.length === 0) {
    return flow.addNode({
      id: newNodeId(),
      type: "group",
      x: origin.x,
      y: origin.y,
      width: 320,
      height: 200,
      label: "group",
    });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of siblings) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + (node.width ?? 152));
    maxY = Math.max(maxY, node.y + (node.height ?? 56));
  }
  const padX = 24;
  const padY = 48;
  const parent = shared instanceof FlowNode ? shared : null;
  const group = flow.addNode({
    id: newNodeId(),
    type: "group",
    x: minX - padX,
    y: minY - padY,
    width: maxX - minX + padX * 2,
    height: maxY - minY + padY + 24,
    label: "group",
    parentId: parent?.id,
  });
  for (const node of siblings) flow.reparent(node.id, group.id);
  return group;
}

/** Innermost group whose box contains the node's center, or null for the flow. */
export function dropParentId(flow: Flow, nodeId: string, absolute: { x: number; y: number }): string | null {
  const node = flow.getNode(nodeId);
  if (!node) return null;
  const cx = absolute.x + (node.width ?? 152) / 2;
  const cy = absolute.y + (node.height ?? 56) / 2;
  let best: { id: string; area: number } | null = null;
  for (const [id, candidate] of flow.nodes) {
    if (candidate.type !== "group" || candidate === node) continue;
    if (node.owns(candidate)) continue;
    const origin = candidate.absOrigin();
    const width = candidate.width ?? 0;
    const height = candidate.height ?? 0;
    if (cx < origin.x || cy < origin.y || cx > origin.x + width || cy > origin.y + height) continue;
    const area = width * height;
    if (!best || area < best.area) best = { id, area };
  }
  return best?.id ?? null;
}
