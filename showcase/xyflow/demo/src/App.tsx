import { FlowNode } from "@here.build/plexus-xyflow-models";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  type ReactFlowInstance,
} from "@here.build/plexus-xyflow";
import { use, useEffect, useMemo, useRef, useState } from "react";

import styles from "./App.module.css";
import { CursorTracker, RemoteCursors } from "./Cursors.js";
import { addGroup, addUntitled, dropParentId, topmost } from "./graph.js";
import { Inspector } from "./Inspector.js";
import { flowNodeTypes } from "./LabelNode.js";
import { PresenceUI } from "./PresenceUI.js";
import { connectFlow, type Transport } from "./sync/connect.js";
import type { DemoPlexus } from "./sync/DemoPlexus.js";
import { hrefWithView, isPeerView } from "./view.js";

const ready = connectFlow();

const TRANSPORT: Record<Transport, { label: string; tone: "live" | "peer" | "local" }> = {
  "durable-object": { label: "live · Durable Object", tone: "live" },
  "shared-worker": { label: "live · this browser", tone: "peer" },
  local: { label: "this tab only", tone: "local" },
};

function selectedParent(plexus: DemoPlexus) {
  const selected = plexus.awareness.selection.get()?.nodes ?? [];
  return selected.find((node) => node.type === "group") ?? (selected[0]?.parent instanceof FlowNode ? selected[0].parent : null);
}

function Canvas({
  plexus,
  transport,
  room,
  peer,
}: {
  plexus: DemoPlexus;
  transport: Transport;
  room: string;
  peer: boolean;
}) {
  const flow = plexus.root;
  const api = useRef<ReactFlowInstance | null>(null);
  const pane = useRef<HTMLDivElement | null>(null);
  const nodeTypes = useMemo(() => flowNodeTypes(plexus), [plexus]);
  const live = transport !== "local";
  const status = TRANSPORT[transport];
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) plexus.redo();
      else plexus.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plexus]);

  const selectLocal = (id: string) => {
    const node = flow.getNode(id);
    if (node) plexus.awareness.setSelection(flow, [node]);
    api.current?.setNodes((nodes) => nodes.map((item) => ({ ...item, selected: item.id === id })));
  };

  const placeNode = (position: { x: number; y: number }) => {
    const node = addUntitled(flow, position, "untitled", selectedParent(plexus));
    selectLocal(node.id);
  };

  const placeGroup = (position: { x: number; y: number }) => {
    const group = addGroup(flow, position, plexus.awareness.selection.get()?.nodes ?? []);
    selectLocal(group.id);
  };

  const copyInvite = async () => {
    const href = hrefWithView(location.href, null);
    await navigator.clipboard.writeText(href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className={styles.canvas} ref={pane}>
      <ReactFlow
        plexus={plexus}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.3}
        defaultEdgeOptions={{
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: "#3f3c36" },
          style: { stroke: "#3f3c36", strokeWidth: 1.7 },
          labelStyle: { fill: "#3f3c36", fontSize: 11, fontWeight: 650 },
          labelBgStyle: { fill: "#e7e2d6" },
          labelBgPadding: [4, 6],
        }}
        deleteKeyCode="Backspace"
        onInit={(instance) => {
          api.current = instance;
        }}
        onPaneClick={(event) => {
          if (event.detail !== 2) return;
          const pos = api.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
          if (pos) placeNode(pos);
        }}
        onNodeDragStop={(_event, node, nodes) => {
          const models = (nodes.length > 0 ? nodes : [node]).flatMap((item) => {
            const model = flow.getNode(item.id);
            return model ? [model] : [];
          });
          const moving = topmost(models);
          const lead = api.current?.getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;
          const parentId = dropParentId(flow, node.id, lead);
          for (const model of moving) {
            const origin =
              api.current?.getInternalNode(model.id)?.internals.positionAbsolute ?? model.absOrigin();
            flow.reparent(model.id, parentId, origin);
          }
        }}
        onSelectionChange={({ nodes }) => {
          const models = nodes.flatMap((n) => {
            const model = flow.getNode(n.id);
            return model ? [model] : [];
          });
          plexus.awareness.setSelection(flow, models.length ? models : null);
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.15} color="#c3bdb0" />
        <Controls />
        <MiniMap
          pannable
          zoomable
          style={{ width: 118, height: 80 }}
          nodeColor={(node) => (node.type === "group" ? "#b9c4b0" : "#8f8a80")}
          maskColor="rgb(28 25 22 / 0.1)"
        />
        <Panel position="top-right">
          <div className={styles.chrome}>
            <span className={`${styles.pill} ${styles[status.tone]}`} title={`room ${room}`}>
              {status.label}
            </span>
            <button type="button" className={styles.tool} onClick={() => plexus.undo()} title="Undo ⌘Z">
              Undo
            </button>
            <button type="button" className={styles.tool} onClick={() => plexus.redo()} title="Redo ⌘⇧Z">
              Redo
            </button>
            <button
              type="button"
              className={styles.tool}
              onClick={() => {
                const inst = api.current;
                if (!inst) return;
                const rect = pane.current?.getBoundingClientRect();
                const x = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;
                const y = (rect?.top ?? 0) + (rect?.height ?? 0) / 2;
                placeNode(inst.screenToFlowPosition({ x, y }));
              }}
            >
              + Node
            </button>
            <button
              type="button"
              className={styles.tool}
              onClick={() => {
                const inst = api.current;
                if (!inst) return;
                const rect = pane.current?.getBoundingClientRect();
                const x = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;
                const y = (rect?.top ?? 0) + (rect?.height ?? 0) / 2;
                placeGroup(inst.screenToFlowPosition({ x, y }));
              }}
            >
              + Group
            </button>
            <PresenceUI awareness={plexus.awareness}>
              {peer ? null : live ? (
                <button type="button" className={styles.tool} onClick={() => void copyInvite()}>
                  {copied ? "Copied" : "Copy link"}
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.retry}
                  title="This tab is its own document. Reload after starting the worker."
                  onClick={() => location.reload()}
                >
                  retry
                </button>
              )}
            </PresenceUI>
          </div>
        </Panel>
        <CursorTracker plexus={plexus} target={pane} />
        <RemoteCursors plexus={plexus} />
      </ReactFlow>
    </div>
  );
}

export function Connecting() {
  const href = typeof location === "undefined" ? "" : location.href;
  const room =
    typeof location === "undefined"
      ? ""
      : (new URLSearchParams(location.search).get("room") ?? "");
  return (
    <div className={`${styles.shell} ${styles.connecting}`}>
      <p className={styles.connectKicker}>Opening the graph</p>
      <p className={styles.connectRoom}>{room ? `room ${room}` : "assigning a room"}</p>
      {href ? <code className={styles.connectUrl}>{href}</code> : null}
    </div>
  );
}

export function App() {
  const session = use(ready);
  const peer = typeof location !== "undefined" && isPeerView(location.search);
  const live = session.transport !== "local";
  const peerSrc = useMemo(
    () => (typeof location === "undefined" ? "" : hrefWithView(location.href, "peer")),
    [],
  );
  const layout = peer ? styles.workspacePeer : live ? styles.workspaceLive : styles.workspace;

  return (
    <ReactFlowProvider>
      <div className={layout}>
        {peer ? null : <Inspector plexus={session.plexus} />}
        <Canvas
          plexus={session.plexus}
          transport={session.transport}
          room={session.room}
          peer={peer}
        />
        {!peer && live ? (
          <aside className={styles.peerPane}>
            <div className={styles.peerBar}>peer</div>
            <iframe className={styles.peerFrame} src={peerSrc} title="Peer client on this room" />
          </aside>
        ) : null}
      </div>
    </ReactFlowProvider>
  );
}
