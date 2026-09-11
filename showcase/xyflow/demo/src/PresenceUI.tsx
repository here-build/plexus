import { observer } from "mobx-react";
import type { ReactNode } from "react";

import type { XyflowAwareness } from "@here.build/plexus-xyflow/plexus";

import styles from "./PresenceUI.module.css";

const Face = observer(function Face({
  awareness,
  clientId,
  self,
}: {
  awareness: XyflowAwareness;
  clientId: number;
  self?: boolean;
}) {
  const published = awareness.name.getOther(clientId);
  const name = typeof published === "string" ? published : "";
  const label = self ? (name ? `${name} (you)` : "you") : name || `peer ${clientId}`;
  return (
    <li
      className={self ? `${styles.face} ${styles.self}` : styles.face}
      title={label}
      aria-label={label}
      style={{ "--presence-face": awareness.fillFor(clientId) }}
    >
      <span className={styles.avatar} dangerouslySetInnerHTML={{ __html: awareness.getAvatar(clientId) }} />
    </li>
  );
});

export const PresenceUI = observer(function PresenceUI({
  awareness,
  children,
}: {
  awareness: XyflowAwareness;
  children?: ReactNode;
}) {
  return (
    <div className={styles.root}>
      <ul className={styles.faces}>
        <Face awareness={awareness} clientId={awareness.clientID} self />
        {[...awareness.name.getOthers().entries()].map(([clientId]) => (
          <Face key={clientId} awareness={awareness} clientId={clientId} />
        ))}
      </ul>
      {children}
    </div>
  );
});
