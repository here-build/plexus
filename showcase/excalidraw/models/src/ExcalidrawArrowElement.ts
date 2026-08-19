import type * as X from "@excalidraw/excalidraw/element/types";
import { syncing } from "@here.build/plexus";

import { type FixedSegment, writeSegments } from "./FixedSegment.js";
import { ExcalidrawLinearElement } from "./ExcalidrawLinearElement.js";

@syncing("ExcalidrawArrowElement")
export class ExcalidrawArrowElement
  extends ExcalidrawLinearElement
  implements X.ExcalidrawArrowElement
{
  readonly type = "arrow";

  @syncing accessor elbowed = false;
  @syncing accessor startIsSpecial: boolean | null = null;
  @syncing accessor endIsSpecial: boolean | null = null;
  @syncing.child.list accessor segments: FixedSegment[] = [];

  get fixedSegments(): X.ExcalidrawElbowArrowElement["fixedSegments"] {
    if (!this.elbowed || this.segments.length === 0) return null;
    return this.segments.map((s) => ({
      start: [s.start?.x ?? 0, s.start?.y ?? 0] as [number, number],
      end: [s.end?.x ?? 0, s.end?.y ?? 0] as [number, number],
      index: s.index,
    })) as NonNullable<X.ExcalidrawElbowArrowElement["fixedSegments"]>;
  }

  set fixedSegments(segs: X.ExcalidrawElbowArrowElement["fixedSegments"]) {
    writeSegments(this.segments, segs ?? []);
  }

  toJSON(): X.ExcalidrawArrowElement {
    return {
      ...super.toJSON(),
      type: this.type,
      elbowed: this.elbowed,
      ...(this.elbowed
        ? {
            startIsSpecial: this.startIsSpecial,
            endIsSpecial: this.endIsSpecial,
            fixedSegments: this.fixedSegments,
          }
        : {}),
    };
  }
}
