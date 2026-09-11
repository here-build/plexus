import { Handle, NodeResizer, Position, type NodeProps, type NodeTypes } from "@here.build/plexus-xyflow";
import { observer } from "mobx-react";

import { remotesOnNode } from "./presence.js";
import type { DemoPlexus } from "./sync/DemoPlexus.js";

import styles from "./LabelNode.module.css";

function Handles({ type }: { type: string | undefined }) {
  const source = type !== "output";
  const target = type !== "input";
  return (
    <>
      {target ? <Handle type="target" position={Position.Left} /> : null}
      {source ? <Handle type="source" position={Position.Right} /> : null}
    </>
  );
}

function groupHue(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return [250, 32, 155, 85][(h >>> 0) % 4]!;
}

const PresenceChrome = observer(function PresenceChrome({
  plexus,
  id,
  group,
}: {
  plexus: DemoPlexus;
  id: string;
  group?: boolean;
}) {
  const node = plexus.root.getNode(id);
  const remotes = remotesOnNode(plexus.awareness, node);
  if (remotes.length === 0) return null;
  return (
    <>
      {remotes.map((remote, index) => (
        <div
          key={remote.clientId}
          className={group ? styles.groupRing : styles.ring}
          style={{
            "--sel-color": remote.color,
            "--sel-inset": `${6 + index * 4}px`,
          }}
        />
      ))}
      <div className={styles.chips}>
        {remotes.map((remote) => (
          <span
            key={remote.clientId}
            className={styles.chip}
            style={{ "--sel-color": remote.color }}
            title={remote.name}
          >
            <span className={styles.chipAvatar} dangerouslySetInnerHTML={{ __html: remote.avatar }} />
            <span className={styles.chipName}>{remote.name}</span>
          </span>
        ))}
      </div>
    </>
  );
});

export function flowNodeTypes(plexus: DemoPlexus): NodeTypes {
  const flow = plexus.root;

  const Label = observer(function LabelNode({ id, type }: NodeProps) {
    const node = flow.getNode(id);
    if (!node) return null;
    return (
      <div className={styles.wrap}>
        <PresenceChrome plexus={plexus} id={id} />
        <div className={styles.node} data-kind={type}>
          <Handles type={type} />
          <input
            className={`nodrag nopan ${styles.input}`}
            value={node.label}
            onChange={(event) => {
              node.label = event.target.value;
            }}
          />
        </div>
      </div>
    );
  });

  const Group = observer(function GroupNode({ id, selected }: NodeProps) {
    const node = flow.getNode(id);
    if (!node) return null;
    const hue = groupHue(id);
    return (
      <div className={`${styles.wrap} ${styles.wrapGroup}`}>
        <PresenceChrome plexus={plexus} id={id} group />
        <NodeResizer isVisible={selected} minWidth={220} minHeight={140} />
        <div
          className={styles.group}
          style={{
            background: `oklch(0.84 0.04 ${hue} / 0.45)`,
            borderColor: `oklch(0.55 0.08 ${hue} / 0.55)`,
          }}
        >
          <div className={styles.groupBar}>
            <input
              className={`nodrag nopan ${styles.groupName}`}
              value={node.label}
              onChange={(event) => {
                node.label = event.target.value;
              }}
            />
          </div>
        </div>
      </div>
    );
  });

  return {
    default: Label,
    input: Label,
    output: Label,
    group: Group,
  };
}
