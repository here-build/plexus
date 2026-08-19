import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";
import type { ExcalidrawAnyElement } from "./types.js";

/** Ownership: children live here, not as `frameId` tags on a flat array. */
@syncing("ExcalidrawFrameLikeElement")
export abstract class ExcalidrawFrameLikeElement extends ExcalidrawElement {
  abstract readonly type: "frame" | "magicframe";

  @syncing accessor name = "";
  @syncing.child.list accessor children: ExcalidrawAnyElement[] = [];

  toJSON(): X.ExcalidrawFrameLikeElement {
    return { ...super.toJSON(), type: this.type, name: this.name };
  }
}
