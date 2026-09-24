import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Excalidraw, MainMenu } from "@here.build/plexus-excalidraw";
import type { Scene } from "@here.build/plexus-excalidraw-models";
import { use, useMemo, useRef, useState } from "react";

import styles from "./App.module.css";
import { PresenceUI } from "./PresenceUI.js";
import { SceneCursors } from "./SceneCursors.js";
import { SceneSelections } from "./SceneSelections.js";
import { connectScene, type Transport } from "./sync/connect.js";
import type { DemoPlexus } from "./sync/DemoPlexus.js";
import { hrefWithView, isPeerView } from "./view.js";

const ready = connectScene();

const TRANSPORT: Record<Transport, { label: string; tone: "live" | "peer" | "local" }> = {
  "durable-object": { label: "live · Durable Object", tone: "live" },
  "shared-worker": { label: "live · this browser", tone: "peer" },
  local: { label: "this tab only", tone: "local" },
};

function Canvas({
  scene,
  plexus,
  transport,
  room,
  peer,
}: {
  scene: Scene;
  plexus: DemoPlexus;
  transport: Transport;
  room: string;
  peer: boolean;
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const planeRef = useRef<HTMLDivElement | null>(null);
  const live = transport !== "local";
  const status = TRANSPORT[transport];
  const [copied, setCopied] = useState(false);

  const copyInvite = async () => {
    const href = hrefWithView(location.href, null);
    await navigator.clipboard.writeText(href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div ref={hostRef} className={styles.canvas}>
      <Excalidraw
        plexus={plexus}
        excalidrawAPI={setApi}
        initialData={{ scrollToContent: true }}
        onChange={(_els, appState: AppState) => {
          const ids = appState.selectedElementIds;
          const next = Object.keys(ids).filter((id) => ids[id]);
          const models = next.flatMap((id) => {
            const node = scene.elements.get(id);
            return node && !node.isDeleted ? [node] : [];
          });
          plexus.awareness.setSelection(scene, models.length ? models : null);
        }}
        renderTopRightUI={(isMobile) => (
          <div className={styles.chrome}>
            {isMobile ? null : (
              <span className={`${styles.pill} ${styles[status.tone]}`} title={`room ${room}`}>
                {status.label}
              </span>
            )}
            <PresenceUI awareness={plexus.awareness} compact={isMobile}>
              {peer || isMobile ? null : live ? (
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
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => plexus.undo()} shortcut="Ctrl+Z">
            Undo
          </MainMenu.Item>
          <MainMenu.Item onSelect={() => plexus.redo()} shortcut="Ctrl+Shift+Z">
            Redo
          </MainMenu.Item>
          {peer ? null : (
            <>
              <MainMenu.Separator />
              <MainMenu.Item onSelect={() => window.open(hrefWithView(location.href, null), "_blank")}>
                Open another tab
              </MainMenu.Item>
            </>
          )}
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
      <div ref={clipRef} className={styles.clip} aria-hidden>
        <div ref={planeRef} className={styles.plane} />
      </div>
      <SceneSelections
        scene={scene}
        awareness={plexus.awareness}
        planeRef={planeRef}
        clipRef={clipRef}
      />
      <SceneCursors
        scene={scene}
        awareness={plexus.awareness}
        hostRef={hostRef}
        planeRef={planeRef}
        clipRef={clipRef}
        api={api}
      />
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
      <p className={styles.connectKicker}>Opening the scene</p>
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
    <div className={layout}>
      <Canvas
        scene={session.plexus.root}
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
  );
}
