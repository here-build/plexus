import { useReactFlow } from "@here.build/plexus-xyflow";
import { observer } from "mobx-react";

import { absoluteCenter, focusNode, ownedTree, pointerList } from "./inspect.js";
import type { DemoPlexus } from "./sync/DemoPlexus.js";

import styles from "./Inspector.module.css";

export const Inspector = observer(function Inspector({ plexus }: { plexus: DemoPlexus }) {
  const flow = plexus.root;
  const { setCenter, setNodes, getZoom } = useReactFlow();
  const local = plexus.awareness.selection.get();
  const selected = local?.nodes[0] ?? null;
  const tree = ownedTree(flow);
  const pointers = pointerList(flow);
  const focus = selected ? focusNode(flow, selected) : null;
  const owner = focus?.ownedBy;

  const reveal = (id: string) => {
    const node = flow.getNode(id);
    if (!node) return;
    plexus.awareness.setSelection(flow, [node]);
    setNodes((nodes) => nodes.map((item) => ({ ...item, selected: item.id === id })));
    const at = absoluteCenter(node);
    setCenter(at.x, at.y, { duration: 200, zoom: Math.min(getZoom(), 1) });
  };

  return (
    <aside className={styles.card}>
      <h2 className={styles.title}>Graph</h2>

      <section>
        <h3 className={styles.section}>
          <code>Flow</code> owns
        </h3>
        <ul className={styles.tree}>
          {tree.map((node) => (
            <OwnedRow
              key={node.id}
              node={node}
              depth={0}
              selectedId={selected?.id}
              onSelect={reveal}
            />
          ))}
        </ul>
      </section>

      <section>
        <h3 className={styles.section}>
          <code>FlowEdge</code> points
        </h3>
        <ul className={styles.list}>
          {pointers.map((edge) => (
            <li key={edge.id}>
              <button
                type="button"
                className={styles.row}
                onClick={() => edge.sourceId && reveal(edge.sourceId)}
              >
                <code className={styles.kind}>ptr</code>
                <span>
                  {edge.sourceLabel} → {edge.targetLabel}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {focus ? (
        <section className={styles.focus}>
          <h3 className={styles.section}>
            <code>{focus.kind}</code> {focus.label || focus.id}
          </h3>
          <dl className={styles.facts}>
            <dt>owned by</dt>
            <dd>
              {!owner || owner.kind === "Flow" ? (
                <code>Flow</code>
              ) : (
                <button type="button" className={styles.link} onClick={() => reveal(owner.id)}>
                  {owner.label || owner.id}
                </button>
              )}
            </dd>
            {focus.owns.length > 0 ? (
              <>
                <dt>owns</dt>
                <dd>
                  {focus.owns.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      className={styles.link}
                      onClick={() => reveal(child.id)}
                    >
                      {child.label || child.id}
                    </button>
                  ))}
                </dd>
              </>
            ) : null}
            {focus.pointers.length > 0 ? (
              <>
                <dt>pointers</dt>
                <dd>
                  {focus.pointers.map((edge) => (
                    <span key={edge.id}>
                      {edge.sourceLabel} → {edge.targetLabel}
                    </span>
                  ))}
                </dd>
              </>
            ) : (
              <>
                <dt>pointers</dt>
                <dd>none</dd>
              </>
            )}
          </dl>
        </section>
      ) : (
        <p className={styles.hint}>select a node</p>
      )}
    </aside>
  );
});

function OwnedRow({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: ReturnType<typeof ownedTree>[number];
  depth: number;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={node.id === selectedId ? `${styles.row} ${styles.selected}` : styles.row}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onSelect(node.id)}
      >
        <code className={styles.kind}>{node.type === "group" ? "owns" : "node"}</code>
        <span>{node.label || node.id}</span>
      </button>
      {node.children.length > 0 ? (
        <ul className={styles.tree}>
          {node.children.map((child) => (
            <OwnedRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
