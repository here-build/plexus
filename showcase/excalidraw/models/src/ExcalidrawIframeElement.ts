import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";

@syncing("ExcalidrawIframeElement")
export class ExcalidrawIframeElement
  extends ExcalidrawElement
  implements X.ExcalidrawIframeElement
{
  readonly type = "iframe";

  @syncing accessor generationStatus: "pending" | "done" | "error" | null = null;
  @syncing accessor generationHtml: string | null = null;
  @syncing accessor generationMessage: string | null = null;
  @syncing accessor generationCode: string | null = null;

  get customData(): X.ExcalidrawIframeElement["customData"] {
    if (this.generationStatus == null) return undefined;
    if (this.generationStatus === "pending") {
      return { generationData: { status: "pending" } };
    }
    if (this.generationStatus === "done") {
      return { generationData: { status: "done", html: this.generationHtml ?? "" } };
    }
    return {
      generationData: {
        status: "error",
        message: this.generationMessage ?? undefined,
        code: this.generationCode ?? "",
      },
    };
  }

  set customData(data: X.ExcalidrawIframeElement["customData"]) {
    const gen = data?.generationData;
    this.generationStatus = gen?.status ?? null;
    this.generationHtml = gen && gen.status === "done" ? gen.html : null;
    this.generationMessage = gen && gen.status === "error" ? (gen.message ?? null) : null;
    this.generationCode = gen && gen.status === "error" ? gen.code : null;
  }

  toJSON(): X.ExcalidrawIframeElement {
    return {
      ...super.toJSON(),
      type: this.type,
      ...(this.customData ? { customData: this.customData } : {}),
    };
  }
}
