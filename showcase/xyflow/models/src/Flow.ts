import type { Connection, Edge, EdgeChange, Node, NodeChange } from "@xyflow/react";
import { PlexusModel, syncing } from "@here.build/plexus";

import { FlowEdge } from "./FlowEdge.js";
import { FlowNode } from "./FlowNode.js";

/**
 * Their graph. `nodes` / `edges` are editor-id → model registries — maps, not
 * ownership. Putting a node in the map materializes it; it belongs to the tree
 * once parented (`children` here, or a node's `children`). Edges always live
 * on `edgeList`. A group owns its children; an edge points at its ends.
 */
@syncing("Flow")
export class Flow extends PlexusModel<null> {
  static {
    FlowNode.Flow = this;
    FlowEdge.Flow = this;
  }

  @syncing.map accessor nodes: Map<string, FlowNode> = new Map();
  @syncing.map accessor edges: Map<string, FlowEdge> = new Map();
  @syncing.child.list accessor children: FlowNode[] = [];
  @syncing.child.list accessor edgeList: FlowEdge[] = [];

  getNode(id: string): FlowNode | null {
    return this.nodes.get(id) ?? null;
  }

  getEdge(id: string): FlowEdge | null {
    return this.edges.get(id) ?? null;
  }

  /** Editor id is the map key. The model does not grow an `id` field. */
  registerNode(node: FlowNode, id: string): void {
    this.nodes.set(id, node);
  }

  registerEdge(edge: FlowEdge, id: string): void {
    this.edges.set(id, edge);
  }

  @syncing.action
  addNode(input: {
    id: string;
    type?: string;
    x: number;
    y: number;
    label?: string;
    width?: number | null;
    height?: number | null;
    parentId?: string;
  }): FlowNode {
    const type = input.type ?? "default";
    const node = new FlowNode({
      type,
      x: input.x,
      y: input.y,
      label: input.label ?? "",
      width: input.width ?? (type === "group" ? 320 : 152),
      height: input.height ?? (type === "group" ? 200 : 58),
    });
    this.registerNode(node, input.id);
    const parent = input.parentId ? this.getNode(input.parentId) : null;
    if (parent) parent.children.push(node);
    else this.children.push(node);
    return node;
  }

  /**
   * Move `nodeId` onto `parentId` (a group) or onto the flow. `absolute` is the
   * node's content-space origin at the moment of the move — drag-stop passes
   * the editor's position so the node does not jump.
   */
  @syncing.action
  reparent(nodeId: string, parentId: string | null, absolute?: { x: number; y: number }): void {
    const node = this.getNode(nodeId);
    if (!node) return;
    const parent = parentId ? this.getNode(parentId) : null;
    if (parent && (parent === node || node.owns(parent))) return;
    const abs = absolute ?? node.absOrigin();
    node.parentId = parent?.id;
    const origin = parent ? parent.absOrigin() : { x: 0, y: 0 };
    node.x = abs.x - origin.x;
    node.y = abs.y - origin.y;
  }

  /** Parent nodes before children — xyflow's invariant. */
  snapshotNodes(): Node[] {
    const out: FlowNode[] = [];
    const emit = (node: FlowNode) => {
      out.push(node);
      for (const child of node.children) emit(child);
    };
    for (const node of this.children) emit(node);
    return out.map((node) => node.toJSON());
  }

  snapshotEdges(): Edge[] {
    return this.edgeList.filter((edge) => edge.source && edge.target).map((edge) => edge.toJSON());
  }

  @syncing.action
  applyNodeChanges(changes: NodeChange[]): void {
    for (const change of changes) {
      switch (change.type) {
        case "select":
          break;
        case "position": {
          const node = this.getNode(change.id);
          if (!node || !change.position) break;
          if (Number.isFinite(change.position.x)) node.x = change.position.x;
          if (Number.isFinite(change.position.y)) node.y = change.position.y;
          break;
        }
        case "dimensions": {
          const node = this.getNode(change.id);
          if (!node || !change.dimensions) break;
          if (change.setAttributes === true || change.setAttributes === "width") {
            node.width = change.dimensions.width;
          }
          if (change.setAttributes === true || change.setAttributes === "height") {
            node.height = change.dimensions.height;
          }
          break;
        }
        case "remove":
          this.#removeNode(change.id);
          break;
        case "add":
          this.#upsertNode(change.item);
          break;
        case "replace": {
          const node = this.getNode(change.id);
          if (node) this.#writeNode(node, change.item);
          else this.#upsertNode(change.item);
          break;
        }
        default:
          break;
      }
    }
  }

  @syncing.action
  applyEdgeChanges(changes: EdgeChange[]): void {
    for (const change of changes) {
      switch (change.type) {
        case "select":
          break;
        case "remove":
          this.#removeEdge(change.id);
          break;
        case "add":
          this.#upsertEdge(change.item);
          break;
        case "replace": {
          const edge = this.getEdge(change.id);
          if (edge) this.#writeEdge(edge, change.item);
          else this.#upsertEdge(change.item);
          break;
        }
        default:
          break;
      }
    }
  }

  @syncing.action
  connect(connection: Connection): void {
    if (!connection.source || !connection.target) return;
    const source = this.getNode(connection.source);
    const target = this.getNode(connection.target);
    if (!source || !target) return;
    const id = `e-${connection.source}-${connection.target}`;
    if (this.edges.has(id)) return;
    const edge = new FlowEdge();
    this.registerEdge(edge, id);
    this.edgeList.push(edge);
    edge.source = source;
    edge.target = target;
    edge.sourceHandle = connection.sourceHandle ?? null;
    edge.targetHandle = connection.targetHandle ?? null;
  }

  #upsertNode(item: Node): void {
    let node = this.getNode(item.id);
    if (!node) {
      node = new FlowNode();
      this.registerNode(node, item.id);
    }
    if (!node.parent) this.children.push(node);
    this.#writeNode(node, item);
  }

  #writeNode(node: FlowNode, item: Node): void {
    if (item.type) node.type = item.type;
    node.x = item.position.x;
    node.y = item.position.y;
    if (item.width != null) node.width = item.width;
    if (item.height != null) node.height = item.height;
    if (item.zIndex != null) node.zIndex = item.zIndex;
    const data = item.data as { label?: string } | undefined;
    if (typeof data?.label === "string") node.label = data.label;
    node.parentId = item.parentId;
  }

  #removeNode(id: string): void {
    const node = this.getNode(id);
    if (!node) return;
    const gone = new Set<FlowNode>();
    const collect = (n: FlowNode) => {
      gone.add(n);
      for (const child of n.children) collect(child);
    };
    collect(node);
    for (const edge of [...this.edgeList]) {
      if ((edge.source && gone.has(edge.source)) || (edge.target && gone.has(edge.target))) {
        this.#removeEdge(edge.id);
      }
    }
    const parent = node.parent;
    const list = parent instanceof FlowNode ? parent.children : this.children;
    const i = list.indexOf(node);
    if (i >= 0) list.splice(i, 1);
    for (const lost of gone) this.nodes.delete(lost.id);
  }

  #upsertEdge(item: Edge): void {
    let edge = this.getEdge(item.id);
    if (!edge) {
      edge = new FlowEdge();
      this.registerEdge(edge, item.id);
      this.edgeList.push(edge);
    }
    this.#writeEdge(edge, item);
  }

  #writeEdge(edge: FlowEdge, item: Edge): void {
    if (item.type) edge.type = item.type;
    edge.source = this.getNode(item.source);
    edge.target = this.getNode(item.target);
    edge.sourceHandle = item.sourceHandle ?? null;
    edge.targetHandle = item.targetHandle ?? null;
    if (typeof item.label === "string") edge.label = item.label;
  }

  #removeEdge(id: string): void {
    const edge = this.getEdge(id);
    if (!edge) return;
    const i = this.edgeList.indexOf(edge);
    if (i >= 0) this.edgeList.splice(i, 1);
    this.edges.delete(id);
  }
}
