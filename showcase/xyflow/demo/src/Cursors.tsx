import { useReactFlow, ViewportPortal } from "@here.build/plexus-xyflow";
import { observer } from "mobx-react";
import { useEffect, type RefObject } from "react";

import type { DemoPlexus } from "./sync/DemoPlexus.js";

import styles from "./Cursors.module.css";

export function CursorTracker({
  plexus,
  target,
}: {
  plexus: DemoPlexus;
  target: RefObject<HTMLElement | null>;
}) {
  const { screenToFlowPosition } = useReactFlow();
  useEffect(() => {
    const pane = target.current;
    if (!pane) return;
    const onMove = (event: PointerEvent) => {
      const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      plexus.awareness.setCursor(plexus.root, pos);
    };
    const onLeave = () => plexus.awareness.setCursor(plexus.root, null);
    pane.addEventListener("pointermove", onMove);
    pane.addEventListener("pointerleave", onLeave);
    return () => {
      pane.removeEventListener("pointermove", onMove);
      pane.removeEventListener("pointerleave", onLeave);
    };
  }, [plexus, screenToFlowPosition, target]);
  return null;
}

export const RemoteCursors = observer(function RemoteCursors({ plexus }: { plexus: DemoPlexus }) {
  const others = plexus.awareness.cursor.getOthers();
  return (
    <ViewportPortal>
      {[...others.entries()].map(([clientId, cursor]) => {
        if (!cursor) return null;
        const color = plexus.awareness.fillFor(clientId);
        return (
          <div
            key={clientId}
            className={styles.cursor}
            style={{
              transform: `translate(${cursor.x}px, ${cursor.y}px)`,
              color,
            }}
          >
            <svg className={styles.pointer} viewBox="0 0 16 20" aria-hidden="true">
              <path
                d="M1.2 1.2 1.2 16.2 5.1 12.4 7.6 18.4 9.7 17.5 7.1 11.3 13.4 11.3Z"
                fill="currentColor"
                stroke="#fff"
                strokeLinejoin="round"
                strokeWidth="1.2"
              />
            </svg>
            <span className={styles.name}>{plexus.awareness.getClientIdentity(clientId).displayName ?? clientId}</span>
          </div>
        );
      })}
    </ViewportPortal>
  );
});
