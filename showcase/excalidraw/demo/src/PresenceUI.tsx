import { observer } from "mobx-react";
import type { ReactNode } from "react";

import type { ExcalidrawAwareness } from "@here.build/plexus-excalidraw/plexus";

import styles from "./PresenceUI.module.css";

export const presenceInviteClass = styles.invite;

const Face = observer(function Face({
  awareness,
  clientId,
  self,
}: {
  awareness: ExcalidrawAwareness;
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
      <span
        className={styles.avatar}
        dangerouslySetInnerHTML={{ __html: awareness.getAvatar(clientId) }}
      />
    </li>
  );
});

/** Host chrome: faces of everyone on this awareness. Local last. */
export const PresenceUI = observer(function PresenceUI({
  awareness,
  compact = false,
  children,
}: {
  awareness: ExcalidrawAwareness;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={compact ? `${styles.root} ${styles.compact}` : styles.root}>
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
