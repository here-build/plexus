import type * as Models from "./index.js";
import { ExcalidrawElement } from "./ExcalidrawElement.js";
import { PlexusModel } from "@here.build/plexus";

/** Discriminant checks only. */

export function isFrame(el: object | null | undefined): el is Models.ExcalidrawFrameElement {
  return el instanceof ExcalidrawElement && el.type === "frame";
}

export function isMagicFrame(
  el: object | null | undefined,
): el is Models.ExcalidrawMagicFrameElement {
  return el instanceof ExcalidrawElement && el.type === "magicframe";
}

export function isFrameLike(
  el: object | null | undefined,
): el is Models.ExcalidrawFrameElement | Models.ExcalidrawMagicFrameElement {
  return isFrame(el) || isMagicFrame(el);
}

export function isArrow(el: object | null | undefined): el is Models.ExcalidrawArrowElement {
  return el instanceof ExcalidrawElement && el.type === "arrow";
}

export function isLine(el: object | null | undefined): el is Models.ExcalidrawLineElement {
  return el instanceof ExcalidrawElement && el.type === "line";
}

export function isLinear(
  el: object | null | undefined,
): el is Models.ExcalidrawArrowElement | Models.ExcalidrawLineElement {
  return isArrow(el) || isLine(el);
}

export function isText(el: object | null | undefined): el is Models.ExcalidrawTextElement {
  return el instanceof ExcalidrawElement && el.type === "text";
}

export function isFreeDraw(el: object | null | undefined): el is Models.ExcalidrawFreeDrawElement {
  return el instanceof ExcalidrawElement && el.type === "freedraw";
}

export function isImage(el: object | null | undefined): el is Models.ExcalidrawImageElement {
  return el instanceof ExcalidrawElement && el.type === "image";
}

export function isEmbeddable(
  el: object | null | undefined,
): el is Models.ExcalidrawEmbeddableElement {
  return el instanceof ExcalidrawElement && el.type === "embeddable";
}

export function isIframe(el: object | null | undefined): el is Models.ExcalidrawIframeElement {
  return el instanceof ExcalidrawElement && el.type === "iframe";
}

export function isScene(el: object | null | undefined): el is Models.Scene {
  return el instanceof PlexusModel && el.__type__ === "Scene";
}
