import { PlexusModel, syncing } from "@here.build/plexus";

import type { ExcalidrawArrowElement } from "./ExcalidrawArrowElement.js";
import { Point } from "./Point.js";

@syncing("FixedSegment")
export class FixedSegment extends PlexusModel<ExcalidrawArrowElement> {
  @syncing.child accessor start: Point | null = null;
  @syncing.child accessor end: Point | null = null;
  @syncing accessor index = 0;
}

export function writeSegments(
  list: FixedSegment[],
  segs: readonly {
    start: readonly number[];
    end: readonly number[];
    index: number;
  }[],
): void {
  while (list.length > segs.length) list.pop();
  for (let i = 0; i < segs.length; i++) {
    const src = segs[i]!;
    let seg = list[i];
    if (!seg) {
      seg = new FixedSegment();
      list.push(seg);
    }
    if (!seg.start) seg.start = new Point();
    if (!seg.end) seg.end = new Point();
    seg.start.x = src.start[0]!;
    seg.start.y = src.start[1]!;
    seg.end.x = src.end[0]!;
    seg.end.y = src.end[1]!;
    seg.index = src.index;
  }
}
