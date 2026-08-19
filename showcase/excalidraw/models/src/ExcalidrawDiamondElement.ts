import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";

@syncing("ExcalidrawDiamondElement")
export class ExcalidrawDiamondElement
  extends ExcalidrawElement
  implements X.ExcalidrawDiamondElement
{
  readonly type = "diamond";

  toJSON(): X.ExcalidrawDiamondElement {
    return { ...super.toJSON(), type: this.type };
  }
}
