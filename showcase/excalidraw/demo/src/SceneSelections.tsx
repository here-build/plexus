import {observer} from "mobx-react";
import {type RefObject, useLayoutEffect, useState} from "react";
import {createPortal} from "react-dom";

import {type ExcalidrawAnyElement, type Scene} from "@here.build/plexus-excalidraw-models";
import {type ExcalidrawAwareness} from "@here.build/plexus-excalidraw/plexus";

import sceneId from "./SceneId.module.css";
import styles from "./SceneSelections.module.css";

const SelBox = observer(function SelBox({
  node,
  chip,
  color,
  name,
  avatar,
  anchor,
  plane,
  clip,
}: {
  node: ExcalidrawAnyElement;
  chip: boolean;
  color: string;
  name: string;
  avatar: string;
  anchor: string;
  plane: HTMLElement;
  clip: HTMLElement;
}) {
  return (
    <>
      {createPortal(
        <div
          className={styles.sel}
          style={{
              width: node.width,
              height: node.height,
              translate: `${node.x}px ${node.y}px`,
              rotate: `${node.angle}rad`,
              "--sel-color": color,
            }}
        />,
        plane,
      )}
      {chip
        ? createPortal(
            <div
              style={{
                  position: "absolute",
                  width: 0,
                  height: 0,
                  left: node.x,
                  top: node.y,
                  anchorName: anchor,
                }}
            />,
            plane,
          )
        : null}
      {chip
        ? createPortal(
            <div
              className={`${sceneId.chip} ${sceneId.selChip}`}
              style={{
                  positionAnchor: anchor,
                  "--id-color": color,
                }}
            >
              <span className={sceneId.avatar} dangerouslySetInnerHTML={{ __html: avatar }} />
              {name ? <span className={sceneId.name}>{name}</span> : null}
            </div>,
            clip,
          )
        : null}
    </>
  );
});

const PeerSelection = observer(function PeerSelection({
  id,
  scene,
  awareness,
  plane,
  clip,
}: {
  id: number;
  scene: Scene;
  awareness: ExcalidrawAwareness;
  plane: HTMLElement;
  clip: HTMLElement;
}) {
  const sel = awareness.selection.getOther(id);
  if (!sel || sel.canvas !== scene) return null;

  const cursor = awareness.cursor.getOther(id);
  const live = sel.elements.filter((node) => !node.isDeleted);

  return live.map((node) => (
    <SelBox
      key={node.uuid}
      node={node}
      chip={(!cursor || cursor.canvas === scene) && node === live[0]}
      color={awareness.fillFor(id)}
      name={awareness.name.getOther(id) ?? ""}
      avatar={awareness.getAvatar(id)}
      anchor={`--s-${id}-${node.uuid}`}
      plane={plane}
      clip={clip}
    />
  ));
});

const SelectionPeers = observer(function SelectionPeers({
  scene,
  awareness,
  plane,
  clip,
}: {
  scene: Scene;
  awareness: ExcalidrawAwareness;
  plane: HTMLElement;
  clip: HTMLElement;
}) {
  return awareness.selection.clientIds
    .filter((id) => id !== awareness.clientID)
    .map((id) => (
      <PeerSelection
        key={id}
        id={id}
        scene={scene}
        awareness={awareness}
        plane={plane}
        clip={clip}
      />
    ));
});

export function SceneSelections({
  scene,
  awareness,
  planeRef,
  clipRef,
}: {
  scene: Scene;
  awareness: ExcalidrawAwareness;
  planeRef: RefObject<HTMLElement | null>;
  clipRef: RefObject<HTMLElement | null>;
}) {
  const [layer, setLayer] = useState(false);
  useLayoutEffect(() => {
    setLayer(Boolean(planeRef.current && clipRef.current));
  }, [planeRef, clipRef]);

  const plane = planeRef.current;
  const clip = clipRef.current;
  if (!layer || !plane || !clip) return null;
  return <SelectionPeers scene={scene} awareness={awareness} plane={plane} clip={clip} />;
}
