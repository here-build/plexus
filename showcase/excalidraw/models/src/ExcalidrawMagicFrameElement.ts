import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawFrameLikeElement } from "./ExcalidrawFrameLikeElement.js";

@syncing("ExcalidrawMagicFrameElement")
export class ExcalidrawMagicFrameElement
  extends ExcalidrawFrameLikeElement
  implements X.ExcalidrawMagicFrameElement
{
  readonly type = "magicframe";

  toJSON(): X.ExcalidrawMagicFrameElement {
    return { ...super.toJSON(), type: this.type };
  }
}
