import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawLinearElement } from "./ExcalidrawLinearElement.js";

@syncing("ExcalidrawLineElement")
export class ExcalidrawLineElement
  extends ExcalidrawLinearElement
  implements X.ExcalidrawLinearElement
{
  readonly type = "line";

  toJSON(): X.ExcalidrawLinearElement {
    return { ...super.toJSON(), type: this.type };
  }
}
