import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";
import type { ExcalidrawFile } from "./ExcalidrawFile.js";

@syncing("ExcalidrawImageElement")
export class ExcalidrawImageElement extends ExcalidrawElement implements X.ExcalidrawImageElement {
  readonly type = "image";

  @syncing accessor file: ExcalidrawFile | null = null;
  @syncing accessor status: X.ExcalidrawImageElement["status"] = "pending";
  @syncing accessor scaleX = 1;
  @syncing accessor scaleY = 1;
  @syncing accessor cropX: number | null = null;
  @syncing accessor cropY: number | null = null;
  @syncing accessor cropWidth: number | null = null;
  @syncing accessor cropHeight: number | null = null;
  @syncing accessor cropNaturalWidth: number | null = null;
  @syncing accessor cropNaturalHeight: number | null = null;

  get fileId(): X.ExcalidrawImageElement["fileId"] {
    return (this.file?.fileId ?? null) as X.ExcalidrawImageElement["fileId"];
  }

  set fileId(id: X.ExcalidrawImageElement["fileId"]) {
    const scene = this.scene;
    this.file = id && scene ? (scene.files.get(id) ?? null) : null;
  }

  get scale(): X.ExcalidrawImageElement["scale"] {
    return [this.scaleX, this.scaleY];
  }

  set scale(value: X.ExcalidrawImageElement["scale"]) {
    this.scaleX = value[0];
    this.scaleY = value[1];
  }

  get crop(): X.ExcalidrawImageElement["crop"] {
    if (
      this.cropX == null ||
      this.cropY == null ||
      this.cropWidth == null ||
      this.cropHeight == null ||
      this.cropNaturalWidth == null ||
      this.cropNaturalHeight == null
    ) {
      return null;
    }
    return {
      x: this.cropX,
      y: this.cropY,
      width: this.cropWidth,
      height: this.cropHeight,
      naturalWidth: this.cropNaturalWidth,
      naturalHeight: this.cropNaturalHeight,
    };
  }

  set crop(value: X.ExcalidrawImageElement["crop"]) {
    if (!value) {
      this.cropX = null;
      this.cropY = null;
      this.cropWidth = null;
      this.cropHeight = null;
      this.cropNaturalWidth = null;
      this.cropNaturalHeight = null;
      return;
    }
    this.cropX = value.x;
    this.cropY = value.y;
    this.cropWidth = value.width;
    this.cropHeight = value.height;
    this.cropNaturalWidth = value.naturalWidth;
    this.cropNaturalHeight = value.naturalHeight;
  }

  toJSON(): X.ExcalidrawImageElement {
    return {
      ...super.toJSON(),
      type: this.type,
      fileId: this.fileId,
      status: this.status,
      scale: this.scale,
      crop: this.crop,
    };
  }
}
