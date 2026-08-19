import type {ExcalidrawImperativeAPI} from "@excalidraw/excalidraw/types";
import {observable, reaction} from "mobx";
import {observer} from "mobx-react";
import {type RefObject, useEffect, useLayoutEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";

import type { ExcalidrawAwareness } from "@here.build/plexus-excalidraw/plexus";
import type {Scene} from "@here.build/plexus-excalidraw-models";
import {type Camera, viewportToScene} from "./camera.js";
import sceneId from "./SceneId.module.css";

const PeerCursor = observer(function PeerCursor({
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
  const cursor = awareness.cursor.getOther(id);
  if (!cursor || cursor.canvas !== scene) return null;

  const anchor = `--c-${id}`;
  const published = awareness.name.getOther(id);
  const label = typeof published === "string" ? published : "";

  return (
    <>
      {createPortal(
        <div
          style={{
              position: "absolute",
              width: 0,
              height: 0,
              left: cursor.x,
              top: cursor.y,
              anchorName: anchor,
            }}
        />,
        plane,
      )}
      {createPortal(
        <div
          className={`${sceneId.chip} ${sceneId.cursor}`}
          data-client-id={id}
          style={{
              positionAnchor: anchor,
              "--cursor-color": awareness.fillFor(id),
              "--id-color": awareness.fillFor(id),
            }}
        >
          <span
            className={sceneId.avatar}
            dangerouslySetInnerHTML={{ __html: awareness.getAvatar(id) }}
          />
          {label ? <span className={sceneId.name}>{label}</span> : null}
        </div>,
        clip,
      )}
    </>
  );
});

const CursorPeers = observer(function CursorPeers({
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
  return awareness.cursor.clientIds
    .filter((id) => id !== awareness.clientID)
    .map((id) => (
      <PeerCursor key={id} id={id} scene={scene} awareness={awareness} plane={plane} clip={clip} />
    ));
});

export function SceneCursors({
  scene,
  awareness,
  hostRef,
  planeRef,
  clipRef,
  api,
}: {
  scene: Scene;
  awareness: ExcalidrawAwareness;
  hostRef: RefObject<HTMLElement | null>;
  planeRef: RefObject<HTMLElement | null>;
  clipRef: RefObject<HTMLElement | null>;
  api: ExcalidrawImperativeAPI | null;
}) {
  const camera = useRef(observable.box<Camera | null>(null)).current;
  const pointer = useRef(observable.box<{ x: number; y: number } | null>(null)).current;
  const [layer, setLayer] = useState(false);

  useLayoutEffect(() => {
    setLayer(Boolean(planeRef.current && clipRef.current));
  }, [planeRef, clipRef, api]);

  useEffect(() => {
    const plane = planeRef.current;
    const host = hostRef.current;
    if (!plane || !host) return;

    const readCamera = () => {
      const cam = api?.getAppState();
      if (cam) camera.set(cam);
    };
    readCamera();

    const stopCam = reaction(
      () => camera.get(),
      (cam) => {
        const zoom = cam?.zoom?.value;
        if (!cam || !zoom) return;
        plane.style.transform = `scale(${zoom}) translate(${cam.scrollX}px, ${cam.scrollY}px)`;
      },
      { fireImmediately: true },
    );

    const stopPtr = reaction(
      () => {
        const cam = camera.get();
        const ptr = pointer.get();
        if (!cam || !ptr) return null;
        const at = viewportToScene(ptr.x, ptr.y, cam);
        if (!at) return null;
        const q = 0.5 / (cam.zoom?.value || 1);
        return { x: Math.round(at.x / q) * q, y: Math.round(at.y / q) * q };
      },
      (at) => {
        awareness.setCursor(scene, at);
      },
      {
        scheduler: (run) => {
          requestAnimationFrame(run);
        },
        equals: (a, b) => a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y),
      },
    );

    const onMove = (event: PointerEvent) => {
      pointer.set({ x: event.clientX, y: event.clientY });
    };
    const onLeave = () => pointer.set(null);
    const onHidden = () => {
      if (document.visibilityState === "hidden") pointer.set(null);
    };

    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onHidden);
    const unscroll = api?.onScrollChange(readCamera);
    const resize = new ResizeObserver(readCamera);
    resize.observe(host);
    window.addEventListener("resize", readCamera);

    return () => {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onHidden);
      unscroll?.();
      resize.disconnect();
      window.removeEventListener("resize", readCamera);
      stopCam();
      stopPtr();
      pointer.set(null);
      awareness.setCursor(scene, null);
    };
  }, [scene, awareness, api, hostRef, planeRef, camera, pointer]);

  const plane = planeRef.current;
  const clip = clipRef.current;
  if (!layer || !plane || !clip) return null;
  return <CursorPeers scene={scene} awareness={awareness} plane={plane} clip={clip} />;
}
