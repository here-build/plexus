import { FlowNode, type Flow } from "@here.build/plexus-xyflow-models";

export type OwnedView = {
  id: string;
  kind: "FlowNode";
  label: string;
  type: string;
  children: OwnedView[];
};

export type PointerView = {
  id: string;
  kind: "FlowEdge";
  sourceId: string | undefined;
  sourceLabel: string;
  targetId: string | undefined;
  targetLabel: string;
};

export type NodeFocus = {
  kind: "FlowNode";
  id: string;
  label: string;
  type: string;
  ownedBy: { kind: "Flow" } | { kind: "FlowNode"; id: string; label: string };
  owns: { id: string; label: string }[];
  pointers: PointerView[];
};

export function ownedTree(flow: Flow): OwnedView[] {
  const walk = (node: FlowNode): OwnedView => ({
    id: node.id,
    kind: "FlowNode",
    label: node.label,
    type: node.type,
    children: node.children.map(walk),
  });
  return flow.children.map(walk);
}

export function pointerList(flow: Flow): PointerView[] {
  return flow.edgeList.map((edge) => ({
    id: edge.id,
    kind: "FlowEdge",
    sourceId: edge.source?.id,
    sourceLabel: edge.source?.label || edge.source?.id || "—",
    targetId: edge.target?.id,
    targetLabel: edge.target?.label || edge.target?.id || "—",
  }));
}

export function focusNode(flow: Flow, node: FlowNode): NodeFocus {
  const parent = node.parent;
  return {
    kind: "FlowNode",
    id: node.id,
    label: node.label,
    type: node.type,
    ownedBy:
      parent instanceof FlowNode
        ? { kind: "FlowNode", id: parent.id, label: parent.label }
        : { kind: "Flow" },
    owns: node.children.map((child) => ({ id: child.id, label: child.label })),
    pointers: flow.edgeList
      .filter((edge) => edge.source === node || edge.target === node)
      .map((edge) => ({
        id: edge.id,
        kind: "FlowEdge" as const,
        sourceId: edge.source?.id,
        sourceLabel: edge.source?.label || edge.source?.id || "—",
        targetId: edge.target?.id,
        targetLabel: edge.target?.label || edge.target?.id || "—",
      })),
  };
}

export function absoluteCenter(node: FlowNode): { x: number; y: number } {
  let x = node.x;
  let y = node.y;
  let parent = node.parent;
  while (parent instanceof FlowNode) {
    x += parent.x;
    y += parent.y;
    parent = parent.parent;
  }
  return {
    x: x + (node.width ?? 140) / 2,
    y: y + (node.height ?? 40) / 2,
  };
}
