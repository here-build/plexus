import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";
import { Point, writePoints } from "./Point.js";

@syncing("ExcalidrawFreeDrawElement")
export class ExcalidrawFreeDrawElement
  extends ExcalidrawElement
  implements X.ExcalidrawFreeDrawElement
{
  readonly type = "freedraw";

  @syncing.child.list accessor vertices: Point[] = [];
  @syncing.list accessor pressures: number[] = [];
  @syncing accessor simulatePressure = true;
  @syncing accessor lastCommittedX: number | null = null;
  @syncing accessor lastCommittedY: number | null = null;

  get points(): X.ExcalidrawFreeDrawElement["points"] {
    return this.vertices.map(
      (p) => [p.x, p.y] as [number, number],
    ) as X.ExcalidrawFreeDrawElement["points"];
  }

  set points(tuples: X.ExcalidrawFreeDrawElement["points"]) {
    writePoints(this.vertices, tuples);
  }

  get lastCommittedPoint(): X.ExcalidrawFreeDrawElement["lastCommittedPoint"] {
    if (this.lastCommittedX == null || this.lastCommittedY == null) return null;
    return [
      this.lastCommittedX,
      this.lastCommittedY,
    ] as X.ExcalidrawFreeDrawElement["lastCommittedPoint"];
  }

  set lastCommittedPoint(point: X.ExcalidrawFreeDrawElement["lastCommittedPoint"]) {
    this.lastCommittedX = point?.[0] ?? null;
    this.lastCommittedY = point?.[1] ?? null;
  }

  toJSON(): X.ExcalidrawFreeDrawElement {
    return {
      ...super.toJSON(),
      type: this.type,
      points: this.points,
      pressures: this.pressures,
      simulatePressure: this.simulatePressure,
      lastCommittedPoint: this.lastCommittedPoint,
    };
  }
}
