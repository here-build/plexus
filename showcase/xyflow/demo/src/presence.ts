import type { FlowNode } from "@here.build/plexus-xyflow-models";
import type { XyflowAwareness } from "@here.build/plexus-xyflow/plexus";

export type RemoteOnNode = {
  clientId: number;
  color: string;
  name: string;
  avatar: string;
};

/** Peers whose published selection includes this model. Empty if nobody else has it. */
export function remotesOnNode(awareness: XyflowAwareness, node: FlowNode | null): RemoteOnNode[] {
  if (!node) return [];
  const out: RemoteOnNode[] = [];
  for (const [clientId, sel] of awareness.selection.getOthers()) {
    if (!sel) continue;
    if (!sel.nodes.some((other) => other === node)) continue;
    out.push({
      clientId,
      color: awareness.fillFor(clientId),
      name: awareness.getClientIdentity(clientId).displayName ?? `peer ${clientId}`,
      avatar: awareness.getAvatar(clientId),
    });
  }
  return out;
}
