import {
  XYFlow,
  type Edge,
  type Node,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  type ReactFlowProps,
} from "./xyflow.js";
import type { Flow } from "@here.build/plexus-xyflow-models";
import { reaction, runInAction } from "mobx";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { mergeLocalSelect } from "./local-select.js";
import type { XyflowPlexus } from "./XyflowPlexus.js";

export type PlexusReactFlowProps = Omit<ReactFlowProps, "nodes" | "edges"> & {
  plexus: XyflowPlexus;
  children?: ReactNode;
};

/**
 * `<ReactFlow>` as a view of a Plexus Flow. `nodes` / `edges` come from the
 * graph. `selected` stays local. Children (`MiniMap`, `Controls`, `Background`)
 * mount inside the real canvas.
 */
export function ReactFlow({
  plexus,
  children,
  onNodesChange,
  onEdgesChange,
  onConnect,
  ...rest
}: PlexusReactFlowProps) {
  const flow = plexus.root;
  const [nodes, setNodes] = useState<Node[]>(() => flow.snapshotNodes());
  const [edges, setEdges] = useState<Edge[]>(() => flow.snapshotEdges());
  const applying = useRef(false);
  const onNodesChangeRef = useRef(onNodesChange);
  onNodesChangeRef.current = onNodesChange;
  const onEdgesChangeRef = useRef(onEdgesChange);
  onEdgesChangeRef.current = onEdgesChange;
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;

  useEffect(() => {
    const fromGraph = reaction(
      () => ({ nodes: flow.snapshotNodes(), edges: flow.snapshotEdges() }),
      ({ nodes: nextNodes, edges: nextEdges }) => {
        if (applying.current) return;
        setNodes((prev) => mergeLocalSelect(nextNodes, prev));
        setEdges((prev) => mergeLocalSelect(nextEdges, prev));
      },
      { fireImmediately: true },
    );
    return fromGraph;
  }, [flow]);

  const handleNodesChange: OnNodesChange = useCallback(
    (changes) => {
      applying.current = true;
      try {
        runInAction(() => flow.applyNodeChanges(changes));
        setNodes((prev) => mergeLocalSelect(flow.snapshotNodes(), prev, changes));
      } finally {
        applying.current = false;
      }
      onNodesChangeRef.current?.(changes);
    },
    [flow],
  );

  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      applying.current = true;
      try {
        runInAction(() => flow.applyEdgeChanges(changes));
        setEdges((prev) => mergeLocalSelect(flow.snapshotEdges(), prev, changes));
      } finally {
        applying.current = false;
      }
      onEdgesChangeRef.current?.(changes);
    },
    [flow],
  );

  const handleConnect: OnConnect = useCallback(
    (connection) => {
      applying.current = true;
      try {
        runInAction(() => flow.connect(connection));
        setEdges((prev) => mergeLocalSelect(flow.snapshotEdges(), prev));
      } finally {
        applying.current = false;
      }
      onConnectRef.current?.(connection);
    },
    [flow],
  );

  return (
    <XYFlow
      {...rest}
      nodes={nodes}
      edges={edges}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onConnect={handleConnect}
    >
      {children}
    </XYFlow>
  );
}

export type { Flow };
