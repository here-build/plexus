import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";

@syncing("ExcalidrawRectangleElement")
export class ExcalidrawRectangleElement
  extends ExcalidrawElement
  implements X.ExcalidrawRectangleElement
{
  readonly type = "rectangle";

  toJSON(): X.ExcalidrawRectangleElement {
    return { ...super.toJSON(), type: this.type };
  }
}
