import type * as X from "@excalidraw/excalidraw/element/types";
import type { FillStyle, StrokeStyle } from "@excalidraw/excalidraw/element/types";
import { PlexusModel, syncing } from "@here.build/plexus";
import { computed } from "mobx";

import type { ExcalidrawFrameLikeElement } from "./ExcalidrawFrameLikeElement.js";
import { isArrow, isFrameLike, isText } from "./guards.js";
import { walk } from "./walk.js";
import type { Scene } from "./Scene.js";
import type { ExcalidrawAnyElement } from "./types.js";

/** `_ExcalidrawElementBase` — the bag minus the `type` discriminant. */
type ExcalidrawElementBase = Omit<X.ExcalidrawSelectionElement, "type">;

@syncing("ExcalidrawElement")
export abstract class ExcalidrawElement<
  Parent extends Scene | ExcalidrawAnyElement = Scene | ExcalidrawFrameLikeElement,
>
  extends PlexusModel<Parent>
  implements ExcalidrawElementBase
{
  static Scene: typeof Scene | undefined;

  abstract readonly type: X.ExcalidrawElement["type"];

  get id() {
    const scene = this.scene;
    if (!scene) return undefined as unknown as string;
    for (const [id, node] of scene.elements) {
      if (node === this) return id;
    }
    return undefined as unknown as string;
  }

  /** Costume. The editor id is the map key; assignment must not punch an own property. */
  set id(_id: string) {}

  /** Scene whose `elements` map holds this node — registered, not necessarily parented. */
  get scene(): Scene | undefined {
    return this.parentsOf(ExcalidrawElement.Scene!, "elements").find(() => true);
  }

  @computed
  get seed(): X.ExcalidrawElement["seed"] {
    let n = 0;
    for (const ch of this.uuid) n = (n + ch.charCodeAt(0)) | 0;
    return n >>> 0;
  }

  /** Costume. Assignment must not throw or punch an own property through the getter. */
  set seed(_n: X.ExcalidrawElement["seed"]) {}

  get isDeleted() {
    return this.isDetached;
  }

  /** Detach. `false` parks a parentless registered node on the Scene; `frameId` then reparents. */
  set isDeleted(value: boolean) {
    const node = this as ExcalidrawElement<any> as ExcalidrawAnyElement;
    if (value) {
      const parent = node.parent;
      if (!parent) return;
      const list = isFrameLike(parent) ? parent.children : (parent as Scene).children;
      const i = list.indexOf(node);
      if (i >= 0) list.splice(i, 1);
      return;
    }
    if (node.parent) return;
    const scene = this.scene;
    if (scene) scene.children.push(node);
  }

  get frameId(): X.ExcalidrawElement["frameId"] {
    return this.parent?.frameId ?? null;
  }

  /** Editor containing-frame id. The getter walks to Scene; this write reparents. */
  set frameId(id: X.ExcalidrawElement["frameId"]) {
    const node = this as ExcalidrawElement<any> as ExcalidrawAnyElement;
    const scene = this.scene;
    if (!scene) return;
    const frame = id ? scene.getElement(id) : null;
    const parent = !isFrameLike(node) && isFrameLike(frame) && frame !== node ? frame : scene;
    const list = isFrameLike(parent) ? parent.children : scene.children;
    if (node.parent === parent && list.includes(node)) return;
    list.push(node);
  }

  @syncing.list accessor groupIds: string[] = [];

  @computed
  get boundElements() {
    const node = this as ExcalidrawElement<any> as ExcalidrawAnyElement;
    const scene = node.rootAncestor as Scene | null;
    if (!scene) return null;
    const out = walk(scene.children)
      .flatMap((el): X.BoundElement[] => {
        const id = el.id;
        if (isArrow(el)) {
          return el.start === node || el.end === node ? [{ id, type: "arrow" }] : [];
        } else if (isText(el)) {
          return el.container === node ? [{ id, type: "text" }] : [];
        } else {
          return [];
        }
      })
      .toArray();
    return out.length ? out : null;
  }

  set boundElements(_v: X.ExcalidrawElement["boundElements"]) {}

  /** Fractional z-order. Excalidraw keeps this in sync with the array. */
  @syncing accessor index: X.ExcalidrawElement["index"] = null;

  /** Costume for `implements`. Not a clock — MobX is. */
  get version() {
    return 1;
  }

  set version(_n: X.ExcalidrawElement["version"]) {}

  get versionNonce() {
    return 0;
  }

  set versionNonce(_n: X.ExcalidrawElement["versionNonce"]) {}

  get updated() {
    return 0;
  }

  set updated(_n: X.ExcalidrawElement["updated"]) {}

  @syncing accessor x = 0;
  @syncing accessor y = 0;
  @syncing accessor width = 100;
  @syncing accessor height = 100;
  @syncing accessor angle = 0 as ExcalidrawElementBase["angle"]; // Radians type is not exported
  @syncing accessor strokeColor = "#1e1e1e";
  @syncing accessor backgroundColor = "transparent";
  @syncing accessor fillStyle = "solid" as FillStyle;
  @syncing accessor strokeWidth = 2;
  @syncing accessor strokeStyle = "solid" as StrokeStyle;
  @syncing accessor roughness = 1;
  @syncing accessor opacity = 100;
  @syncing accessor locked = false;
  @syncing accessor link: X.ExcalidrawElement["link"] = null;
  @syncing accessor roundnessType: X.RoundnessType | null = null;
  @syncing accessor roundnessValue: number | null = null;

  get roundness(): X.ExcalidrawElement["roundness"] {
    if (this.roundnessType == null) return null;
    return this.roundnessValue == null
      ? { type: this.roundnessType }
      : { type: this.roundnessType, value: this.roundnessValue };
  }

  set roundness(value: X.ExcalidrawElement["roundness"]) {
    if (!value) {
      this.roundnessType = null;
      this.roundnessValue = null;
      return;
    }
    this.roundnessType = value.type;
    this.roundnessValue = value.value ?? null;
  }

  /** Editor bag minus `type`. Containing-frame id, not the parent walk. */
  toJSON(): ExcalidrawElementBase {
    const parent = this.parent;
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      angle: this.angle,
      strokeColor: this.strokeColor,
      backgroundColor: this.backgroundColor,
      fillStyle: this.fillStyle,
      strokeWidth: this.strokeWidth,
      strokeStyle: this.strokeStyle,
      roughness: this.roughness,
      opacity: this.opacity,
      seed: this.seed,
      locked: this.locked,
      link: this.link,
      roundness: this.roundness,
      isDeleted: this.isDeleted,
      groupIds: this.groupIds,
      frameId: isFrameLike(parent) ? parent.id : null,
      boundElements: this.boundElements,
      index: this.index,
      version: this.version,
      versionNonce: this.versionNonce,
      updated: this.updated,
    };
  }
}
