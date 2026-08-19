import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawFrameLikeElement } from "./ExcalidrawFrameLikeElement.js";

@syncing("ExcalidrawFrameElement")
export class ExcalidrawFrameElement
  extends ExcalidrawFrameLikeElement
  implements X.ExcalidrawFrameElement
{
  readonly type = "frame";

  toJSON(): X.ExcalidrawFrameElement {
    return { ...super.toJSON(), type: this.type };
  }
}
