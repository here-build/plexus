import type { Edge } from "@xyflow/react";
import { PlexusModel, syncing } from "@here.build/plexus";

import type { Flow } from "./Flow.js";
import type { FlowNode } from "./FlowNode.js";

@syncing("FlowEdge")
export class FlowEdge extends PlexusModel<Flow> {
  static Flow: typeof Flow | undefined;

  @syncing accessor type = "default";
  @syncing accessor source: FlowNode | null = null;
  @syncing accessor target: FlowNode | null = null;
  @syncing accessor sourceHandle: string | null = null;
  @syncing accessor targetHandle: string | null = null;
  @syncing accessor label = "";

  get id() {
    const flow = this.flow;
    if (!flow) return undefined as unknown as string;
    for (const [id, edge] of flow.edges) {
      if (edge === this) return id;
    }
    return undefined as unknown as string;
  }

  /** Costume. The editor id is the map key; assignment must not punch an own property. */
  set id(_id: string) {}

  get flow(): Flow | undefined {
    const Flow = FlowEdge.Flow;
    if (!Flow) return undefined;
    return this.parentsOf(Flow, "edges").find(() => true) ?? (this.parent instanceof Flow ? this.parent : undefined);
  }

  toJSON(): Edge {
    return {
      id: this.id,
      type: this.type,
      source: this.source?.id ?? "",
      target: this.target?.id ?? "",
      ...(this.sourceHandle ? { sourceHandle: this.sourceHandle } : {}),
      ...(this.targetHandle ? { targetHandle: this.targetHandle } : {}),
      ...(this.label ? { label: this.label } : {}),
    };
  }
}
