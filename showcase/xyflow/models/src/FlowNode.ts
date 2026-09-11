import type { Node } from "@xyflow/react";
import { PlexusModel, syncing } from "@here.build/plexus";
import { computed } from "mobx";

import type { Flow } from "./Flow.js";

@syncing("FlowNode")
export class FlowNode extends PlexusModel<Flow | FlowNode> {
  static Flow: typeof Flow | undefined;

  @syncing accessor type = "default";
  @syncing accessor x = 0;
  @syncing accessor y = 0;
  @syncing accessor width: number | null = null;
  @syncing accessor height: number | null = null;
  @syncing accessor label = "";
  @syncing accessor zIndex = 0;
  @syncing.child.list accessor children: FlowNode[] = [];

  get id() {
    const flow = this.flow;
    if (!flow) return undefined as unknown as string;
    for (const [id, node] of flow.nodes) {
      if (node === this) return id;
    }
    return undefined as unknown as string;
  }

  /** Costume. The editor id is the map key; assignment must not punch an own property. */
  set id(_id: string) {}

  get flow(): Flow | undefined {
    const Flow = FlowNode.Flow;
    if (!Flow) return undefined;
    const fromMap = this.parentsOf(Flow, "nodes").find(() => true);
    if (fromMap) return fromMap;
    let cur: PlexusModel | null = this.parent;
    while (cur) {
      if (cur instanceof Flow) return cur;
      cur = cur.parent;
    }
    return undefined;
  }

  @computed
  get position(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  set position(value: { x: number; y: number }) {
    this.x = value.x;
    this.y = value.y;
  }

  get parentId(): string | undefined {
    return this.parent instanceof FlowNode ? this.parent.id : undefined;
  }

  set parentId(id: string | undefined) {
    const flow = this.flow;
    if (!flow) return;
    const parent = id ? flow.getNode(id) : null;
    if (parent === this || (parent && this.owns(parent))) return;
    const next = parent ?? flow;
    const list = next instanceof FlowNode ? next.children : flow.children;
    if (this.parent === next && list.includes(this)) return;
    list.push(this);
  }

  /** Content-space origin: this node's x/y plus every owning group's x/y. */
  absOrigin(): { x: number; y: number } {
    let x = this.x;
    let y = this.y;
    let cur = this.parent;
    while (cur instanceof FlowNode) {
      x += cur.x;
      y += cur.y;
      cur = cur.parent;
    }
    return { x, y };
  }

  owns(node: FlowNode): boolean {
    for (const child of this.children) {
      if (child === node || child.owns(node)) return true;
    }
    return false;
  }

  get data(): { label: string } {
    return { label: this.label };
  }

  set data(value: { label?: string } | undefined) {
    if (value && typeof value.label === "string") this.label = value.label;
  }

  toJSON(): Node {
    return {
      id: this.id,
      type: this.type,
      position: { x: this.x, y: this.y },
      data: { label: this.label },
      parentId: this.parentId,
      ...(this.width != null ? { width: this.width } : {}),
      ...(this.height != null ? { height: this.height } : {}),
      ...(this.zIndex !== 0 ? { zIndex: this.zIndex } : {}),
    };
  }
}
