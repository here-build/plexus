import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { ExcalidrawElement } from "./ExcalidrawElement.js";
import { Point, writePoints } from "./Point.js";
import type { ExcalidrawAnyElement } from "./types.js";

/** Shared line/arrow body. Ends are pointers; delete the target, the stroke stays. */
@syncing("ExcalidrawLinearElement")
export abstract class ExcalidrawLinearElement
  extends ExcalidrawElement
  implements X.ExcalidrawLinearElement
{
  abstract readonly type: "line" | "arrow";

  @syncing.child.list accessor vertices: Point[] = [];
  @syncing accessor start: ExcalidrawAnyElement | null = null;
  @syncing accessor end: ExcalidrawAnyElement | null = null;
  @syncing accessor startFocus = 0;
  @syncing accessor startGap = 1;
  @syncing accessor endFocus = 0;
  @syncing accessor endGap = 1;
  @syncing accessor startFixedX: number | null = null;
  @syncing accessor startFixedY: number | null = null;
  @syncing accessor endFixedX: number | null = null;
  @syncing accessor endFixedY: number | null = null;
  @syncing accessor lastCommittedX: number | null = null;
  @syncing accessor lastCommittedY: number | null = null;
  @syncing accessor startArrowhead: X.ExcalidrawLinearElement["startArrowhead"] = null;
  @syncing accessor endArrowhead: X.ExcalidrawLinearElement["endArrowhead"] = null;

  get points(): X.ExcalidrawLinearElement["points"] {
    return this.vertices.map(
      (p) => [p.x, p.y] as [number, number],
    ) as X.ExcalidrawLinearElement["points"];
  }

  set points(tuples: X.ExcalidrawLinearElement["points"]) {
    writePoints(this.vertices, tuples);
  }

  get lastCommittedPoint(): X.ExcalidrawLinearElement["lastCommittedPoint"] {
    if (this.lastCommittedX == null || this.lastCommittedY == null) return null;
    return [
      this.lastCommittedX,
      this.lastCommittedY,
    ] as X.ExcalidrawLinearElement["lastCommittedPoint"];
  }

  set lastCommittedPoint(point: X.ExcalidrawLinearElement["lastCommittedPoint"]) {
    this.lastCommittedX = point?.[0] ?? null;
    this.lastCommittedY = point?.[1] ?? null;
  }

  get startBinding(): X.ExcalidrawLinearElement["startBinding"] {
    return bindingOf(
      this.start,
      this.startFocus,
      this.startGap,
      this.startFixedX,
      this.startFixedY,
    );
  }

  set startBinding(binding: X.ExcalidrawLinearElement["startBinding"]) {
    writeBinding(this, "start", binding);
  }

  get endBinding(): X.ExcalidrawLinearElement["endBinding"] {
    return bindingOf(this.end, this.endFocus, this.endGap, this.endFixedX, this.endFixedY);
  }

  set endBinding(binding: X.ExcalidrawLinearElement["endBinding"]) {
    writeBinding(this, "end", binding);
  }

  toJSON(): X.ExcalidrawLinearElement {
    return {
      ...super.toJSON(),
      type: this.type,
      points: this.points,
      lastCommittedPoint: this.lastCommittedPoint,
      startBinding: this.startBinding,
      endBinding: this.endBinding,
      startArrowhead: this.startArrowhead,
      endArrowhead: this.endArrowhead,
    };
  }
}

function bindingOf(
  target: ExcalidrawAnyElement | null,
  focus: number,
  gap: number,
  fixedX: number | null,
  fixedY: number | null,
): X.ExcalidrawLinearElement["startBinding"] {
  if (!target) return null;
  const base = { elementId: target.id, focus, gap };
  if (fixedX == null || fixedY == null) return base;
  return { ...base, fixedPoint: [fixedX, fixedY] } as X.ExcalidrawLinearElement["startBinding"];
}

function writeBinding(
  node: ExcalidrawLinearElement,
  end: "start" | "end",
  binding:
    X.ExcalidrawLinearElement["startBinding"] | X.ExcalidrawElbowArrowElement["startBinding"],
): void {
  const scene = node.scene;
  const target = binding && scene ? scene.getElement(binding.elementId) : null;
  const fixed =
    binding && "fixedPoint" in binding && binding.fixedPoint != null ? binding.fixedPoint : null;
  if (end === "start") {
    node.start = target;
    node.startFocus = binding?.focus ?? 0;
    node.startGap = binding?.gap ?? 1;
    node.startFixedX = fixed?.[0] ?? null;
    node.startFixedY = fixed?.[1] ?? null;
  } else {
    node.end = target;
    node.endFocus = binding?.focus ?? 0;
    node.endGap = binding?.gap ?? 1;
    node.endFixedX = fixed?.[0] ?? null;
    node.endFixedY = fixed?.[1] ?? null;
  }
}
