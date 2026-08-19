import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";

@syncing("ExcalidrawEmbeddableElement")
export class ExcalidrawEmbeddableElement
  extends ExcalidrawElement
  implements X.ExcalidrawEmbeddableElement
{
  readonly type = "embeddable";

  toJSON(): X.ExcalidrawEmbeddableElement {
    return { ...super.toJSON(), type: this.type };
  }
}
