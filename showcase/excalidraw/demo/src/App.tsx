import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Excalidraw, MainMenu } from "@here.build/plexus-excalidraw";
import type { Scene } from "@here.build/plexus-excalidraw-models";
import { use, useRef, useState } from "react";

import styles from "./App.module.css";
import { PresenceUI, presenceInviteClass } from "./PresenceUI.js";
import { SceneCursors } from "./SceneCursors.js";
import { SceneSelections } from "./SceneSelections.js";
import { connectScene } from "./sync/connect.js";
import type { DemoPlexus } from "./sync/DemoPlexus.js";

const ready = connectScene();

function Canvas({ scene, plexus }: { scene: Scene; plexus: DemoPlexus }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const planeRef = useRef<HTMLDivElement | null>(null);

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
          <PresenceUI awareness={plexus.awareness} compact={isMobile}>
            <button
              type="button"
              className={presenceInviteClass}
              title="Open another tab"
              aria-label="Open another tab"
              onClick={() => window.open(location.href, "_blank")}
            >
              +
            </button>
          </PresenceUI>
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => plexus.undo()} shortcut="Ctrl+Z">
            Undo
          </MainMenu.Item>
          <MainMenu.Item onSelect={() => plexus.redo()} shortcut="Ctrl+Shift+Z">
            Redo
          </MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.Item onSelect={() => window.open(location.href, "_blank")}>
            Open another tab
          </MainMenu.Item>
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
  return (
    <div className={`${styles.shell} ${styles.connecting}`}>
      <span>connecting…</span>
    </div>
  );
}

export function App() {
  const plexus = use(ready);
  return (
    <div className={styles.shell}>
      <Canvas scene={plexus.root} plexus={plexus} />
    </div>
  );
}
