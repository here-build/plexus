import type { AppState } from "@excalidraw/excalidraw/types";

export type Camera = Pick<AppState, "zoom" | "offsetLeft" | "offsetTop" | "scrollX" | "scrollY">;

/** Viewport → scene. Same formula as `viewportCoordsToSceneCoords`. */
export function viewportToScene(clientX: number, clientY: number, camera: Camera) {
  const zoom = camera.zoom?.value;
  if (!zoom) return null;
  return {
    x: (clientX - camera.offsetLeft) / zoom - camera.scrollX,
    y: (clientY - camera.offsetTop) / zoom - camera.scrollY,
  };
}
