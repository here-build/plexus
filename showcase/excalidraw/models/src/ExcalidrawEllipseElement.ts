import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";

@syncing("ExcalidrawEllipseElement")
export class ExcalidrawEllipseElement
  extends ExcalidrawElement
  implements X.ExcalidrawEllipseElement
{
  readonly type = "ellipse";

  toJSON(): X.ExcalidrawEllipseElement {
    return { ...super.toJSON(), type: this.type };
  }
}
