import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";
import type { ExcalidrawAnyElement } from "./types.js";

@syncing("ExcalidrawTextElement")
export class ExcalidrawTextElement extends ExcalidrawElement implements X.ExcalidrawTextElement {
  readonly type = "text";

  @syncing accessor text = "";
  @syncing accessor fontSize = 20;
  @syncing accessor fontFamily = 1;
  @syncing accessor textAlign = "left";
  @syncing accessor verticalAlign = "top";
  @syncing accessor autoResize = true;
  @syncing accessor lineHeight = 1.25 as X.ExcalidrawTextElement["lineHeight"];
  @syncing accessor originalText = "";
  /** Bound label. Pointer, not parent — a text node can sit in a frame and label a shape. */
  @syncing accessor container: ExcalidrawAnyElement | null = null;

  get containerId() {
    return this.container?.id ?? null;
  }

  set containerId(id: X.ExcalidrawTextElement["containerId"]) {
    const scene = this.scene;
    this.container = id && scene ? scene.getElement(id) : null;
  }

  toJSON(): X.ExcalidrawTextElement {
    return {
      ...super.toJSON(),
      type: this.type,
      text: this.text,
      originalText: this.originalText,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      textAlign: this.textAlign,
      verticalAlign: this.verticalAlign,
      containerId: this.containerId,
      autoResize: this.autoResize,
      lineHeight: this.lineHeight,
    };
  }
}
